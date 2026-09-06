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

type failingHashes struct {
	*inbox.Store
	kind    string
	failure error
}

func (s failingHashes) SetUserAccessHash(ctx context.Context, account, target, hash int64) error {
	if s.kind == "user" {
		return s.failure
	}
	return s.Store.SetUserAccessHash(ctx, account, target, hash)
}
func (s failingHashes) SetChannelAccessHash(ctx context.Context, account, target, hash int64) error {
	if s.kind == "channel" {
		return s.failure
	}
	return s.Store.SetChannelAccessHash(ctx, account, target, hash)
}

func TestManagerHashFailureCheckpointBoundary(t *testing.T) {
	for _, kind := range []string{"user", "channel", "success"} {
		for _, guarded := range []bool{false, true} {
			name := kind + "/unguarded"
			if guarded {
				name = kind + "/guarded"
			}
			t.Run(name, func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				s, err := inbox.Open(ctx, filepath.Join(t.TempDir(), "hash-fence.sqlite"), 1<<20)
				if err != nil {
					t.Fatal(err)
				}
				defer s.Close()
				if err := s.SetState(ctx, 101, updates.State{Pts: 10, Date: 100}); err != nil {
					t.Fatal(err)
				}
				f := NewFailureFence(ctx)
				defer f.Close()
				failure := errors.New("injected hash storage failure")
				faulty := failingHashes{Store: s, kind: kind, failure: failure}
				var channels updates.ChannelAccessHasher = faulty
				var users updates.UserAccessHasher = faulty
				if guarded {
					h := HashStorage{ChannelAccessHasher: faulty, UserAccessHasher: faulty, Fence: f}
					channels = h
					users = h
				}
				observed := persistentObserved{Store: s, committed: make(chan int, 1)}
				manager := updates.New(updates.Config{
					Storage: CheckpointStorage{StateStorage: observed, Fence: f}, AccessHasher: channels, UserAccessHasher: users,
					Handler: telegram.UpdateHandlerFunc(func(ctx context.Context, u tg.UpdatesClass) error {
						return f.Apply(ctx, func(ctx context.Context) error {
							b := new(bin.Buffer)
							if err := u.Encode(b); err != nil {
								return err
							}
							_, err := s.Put(ctx, "101", "single-hash-failure-fixture", b.Buf)
							return err
						})
					}),
				})
				started, done := make(chan struct{}), make(chan error, 1)
				go func() {
					done <- manager.Run(f.Context(), auditAPI{}, 101, updates.AuthOptions{OnStart: func(context.Context) { close(started) }})
				}()
				select {
				case <-started:
				case <-ctx.Done():
					t.Fatal("manager start timeout")
				}
				update := &tg.Updates{Date: 100, Updates: []tg.UpdateClass{&tg.UpdateDeleteMessages{Messages: []int{12}, Pts: 11, PtsCount: 1}}}
				if kind == "user" {
					u := &tg.User{ID: 202}
					u.SetAccessHash(303)
					update.Users = []tg.UserClass{u}
				} else {
					c := &tg.Channel{ID: 202, Title: "fixture", Photo: &tg.ChatPhotoEmpty{}}
					c.SetAccessHash(303)
					update.Chats = []tg.ChatClass{c}
				}
				if err := manager.Handle(f.Context(), update); err != nil && !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
				if guarded && kind != "success" {
					select {
					case <-f.Context().Done():
					case <-ctx.Done():
						t.Fatal("hash failure did not cancel")
					}
					if !errors.Is(f.Err(), failure) {
						t.Errorf("wrong fence failure: %v", f.Err())
					}
				} else {
					select {
					case pts := <-observed.committed:
						if pts != 11 {
							t.Error("unexpected checkpoint")
						}
					case <-ctx.Done():
						t.Fatal("unguarded checkpoint did not advance")
					}
				}
				f.Close()
				select {
				case err := <-done:
					if err != nil && !errors.Is(err, context.Canceled) {
						t.Fatal(err)
					}
				case <-ctx.Done():
					t.Fatal("manager stop timeout")
				}
				state, _, err := s.GetState(ctx, 101)
				if err != nil {
					t.Fatal(err)
				}
				pending, err := s.Pending(ctx, 10)
				if err != nil {
					t.Fatal(err)
				}
				wantPTS, wantPending := 11, 1
				if guarded && kind != "success" {
					wantPTS, wantPending = 10, 0
				}
				if state.Pts != wantPTS || len(pending) != wantPending {
					t.Fatalf("pts=%d pending=%d want=%d/%d", state.Pts, len(pending), wantPTS, wantPending)
				}
				if kind == "success" {
					hash, found, err := s.GetChannelAccessHash(ctx, 101, 202)
					if err != nil || !found || hash != 303 {
						t.Fatalf("committed channel hash=%d found=%v err=%v", hash, found, err)
					}
				}
			})
		}
	}
}

func TestHashWritesBlockedAfterFenceFailure(t *testing.T) {
	f := NewFailureFence(context.Background())
	defer f.Close()
	failure := errors.New("injected ingress failure")
	f.Apply(context.Background(), func(context.Context) error { return failure })
	h := HashStorage{Fence: f}
	if err := h.SetUserAccessHash(context.Background(), 101, 202, 303); !errors.Is(err, failure) {
		t.Fatal(err)
	}
	if err := h.SetChannelAccessHash(context.Background(), 101, 202, 303); !errors.Is(err, failure) {
		t.Fatal(err)
	}
}
