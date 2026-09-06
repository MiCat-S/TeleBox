package telegramio

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/gotd/td/bin"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/updates"
	"github.com/gotd/td/tg"
	"telebox.local/rewrite-probe/inbox"
)

func TestFenceBlocksEveryCheckpointMutation(t *testing.T) {
	f := NewFailureFence(context.Background())
	defer f.Close()
	failure := errors.New("ingress failed")
	if err := f.Apply(context.Background(), func(context.Context) error { return failure }); !errors.Is(err, failure) {
		t.Fatal(err)
	}
	// A nil underlying store ensures no write reaches storage after failure.
	s := CheckpointStorage{Fence: f}
	ctx := context.Background()
	for _, write := range []func() error{
		func() error { return s.SetState(ctx, 1, updates.State{}) },
		func() error { return s.SetPts(ctx, 1, 2) },
		func() error { return s.SetQts(ctx, 1, 2) },
		func() error { return s.SetDate(ctx, 1, 2) },
		func() error { return s.SetSeq(ctx, 1, 2) },
		func() error { return s.SetDateSeq(ctx, 1, 2, 3) },
		func() error { return s.SetChannelPts(ctx, 1, 2, 3) },
	} {
		if err := write(); !errors.Is(err, failure) {
			t.Fatalf("failure latch lost: %v", err)
		}
	}
	if !errors.Is(f.Context().Err(), context.Canceled) {
		t.Fatal("manager context not canceled")
	}
}

func TestFencePanicStopsLaterWrites(t *testing.T) {
	f := NewFailureFence(context.Background())
	defer f.Close()
	if err := f.Apply(context.Background(), func(context.Context) error { panic("synthetic") }); err == nil {
		t.Fatal("panic not latched")
	}
	if err := f.Apply(context.Background(), func(context.Context) error { t.Error("write after panic"); return nil }); err == nil {
		t.Fatal("latch cleared")
	}
}

type observedStorage struct {
	*auditStorage
	ptsAttempt chan struct{}
}

func (s observedStorage) SetPts(ctx context.Context, uid int64, pts int) error {
	err := s.auditStorage.SetPts(ctx, uid, pts)
	select {
	case s.ptsAttempt <- struct{}{}:
	default:
	}
	return err
}

func TestManagerDurableIngressFence(t *testing.T) {
	for _, mode := range []string{"success", "inbox-full", "checkpoint-failure"} {
		t.Run(mode, func(t *testing.T) {
			parent, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			f := NewFailureFence(parent)
			defer f.Close()
			quota := int64(1024 * 1024)
			if mode == "inbox-full" {
				quota = 1
			}
			store, err := inbox.Open(parent, filepath.Join(t.TempDir(), "inbox.sqlite"), quota)
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			base := &auditStorage{state: updates.State{Pts: 10, Date: 100}, failPTS: mode == "checkpoint-failure"}
			observed := observedStorage{auditStorage: base, ptsAttempt: make(chan struct{}, 1)}
			mgr := updates.New(updates.Config{
				Storage: CheckpointStorage{StateStorage: observed, Fence: f},
				Handler: telegram.UpdateHandlerFunc(func(ctx context.Context, u tg.UpdatesClass) error {
					return f.Apply(ctx, func(ctx context.Context) error {
						b := new(bin.Buffer)
						if err := u.Encode(b); err != nil {
							return err
						}
						// Fixed key only for this single synthetic update.
						_, err := store.Put(ctx, "101", "synthetic-update", b.Buf)
						return err
					})
				}),
			})
			started := make(chan struct{})
			done := make(chan error, 1)
			go func() {
				done <- mgr.Run(f.Context(), auditAPI{}, 101, updates.AuthOptions{OnStart: func(context.Context) { close(started) }})
			}()
			select {
			case <-started:
			case <-parent.Done():
				t.Fatal("manager start timed out")
			}
			u := &tg.UpdateShort{Date: 100, Update: &tg.UpdateDeleteMessages{Messages: []int{12}, Pts: 11, PtsCount: 1}}
			if err := mgr.Handle(f.Context(), u); err != nil {
				t.Fatal(err)
			}
			if mode == "success" {
				select {
				case <-observed.ptsAttempt:
				case <-parent.Done():
					t.Fatal("checkpoint not written")
				}
			} else {
				select {
				case <-f.Context().Done():
				case <-parent.Done():
					t.Fatal("fault did not stop manager")
				}
				if f.Err() == nil {
					t.Fatal("fault not recorded")
				}
			}
			f.Close()
			select {
			case err := <-done:
				if err != nil && !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
			case <-parent.Done():
				t.Fatal("manager failed to exit")
			}
			state, _, err := base.GetState(parent, 101)
			if err != nil {
				t.Fatal(err)
			}
			wantPTS := 10
			if mode == "success" {
				wantPTS = 11
			}
			if state.Pts != wantPTS {
				t.Fatalf("checkpoint crossed failed ingress: got %d want %d", state.Pts, wantPTS)
			}
			events, err := store.Pending(parent, 10)
			if err != nil {
				t.Fatal(err)
			}
			wantEvents := 1
			if mode == "inbox-full" {
				wantEvents = 0
			}
			if len(events) != wantEvents {
				t.Fatalf("durable events=%d want=%d", len(events), wantEvents)
			}
			if len(events) == 1 {
				if _, err := tg.DecodeUpdates(&bin.Buffer{Buf: events[0].Payload}); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}
