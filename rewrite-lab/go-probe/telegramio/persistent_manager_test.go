package telegramio

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/gotd/td/bin"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/updates"
	"github.com/gotd/td/tg"
	"telebox.local/rewrite-probe/inbox"
)

type persistentObserved struct {
	*inbox.Store
	committed chan int
}

func (s persistentObserved) SetPts(ctx context.Context, uid int64, pts int) error {
	if err := s.Store.SetPts(ctx, uid, pts); err != nil {
		return err
	}
	s.committed <- pts
	return nil
}

func TestManagerContinuesFromReopenedSQLite(t *testing.T) {
	parent, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	path := filepath.Join(t.TempDir(), "runtime.sqlite")
	for pts := 11; pts <= 12; pts++ {
		s, err := inbox.Open(parent, path, 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		if pts == 11 {
			if err := s.SetState(parent, 101, updates.State{Pts: 10, Date: 100}); err != nil {
				s.Close()
				t.Fatal(err)
			}
		}
		state, found, err := s.GetState(parent, 101)
		if err != nil || !found || state.Pts != pts-1 {
			s.Close()
			t.Fatalf("startup checkpoint: %+v %v", state, err)
		}
		f := NewFailureFence(parent)
		observed := persistentObserved{Store: s, committed: make(chan int, 1)}
		hashes := HashStorage{ChannelAccessHasher: s, UserAccessHasher: s, Fence: f}
		mgr := updates.New(updates.Config{
			Storage: CheckpointStorage{StateStorage: observed, Fence: f}, AccessHasher: hashes, UserAccessHasher: hashes,
			Handler: telegram.UpdateHandlerFunc(func(ctx context.Context, u tg.UpdatesClass) error {
				return f.Apply(ctx, func(ctx context.Context) error {
					b := new(bin.Buffer)
					if err := u.Encode(b); err != nil {
						return err
					}
					_, err := s.Put(ctx, "101", fmt.Sprintf("synthetic:%d", pts), b.Buf)
					return err
				})
			}),
		})
		started, done := make(chan struct{}), make(chan error, 1)
		go func() {
			done <- mgr.Run(f.Context(), auditAPI{}, 101, updates.AuthOptions{OnStart: func(context.Context) { close(started) }})
		}()
		select {
		case <-started:
		case <-parent.Done():
			f.Close()
			s.Close()
			t.Fatal("start timeout")
		}
		err = mgr.Handle(f.Context(), &tg.UpdateShort{Date: 100, Update: &tg.UpdateDeleteMessages{Messages: []int{12}, Pts: pts, PtsCount: 1}})
		if err != nil {
			f.Close()
			s.Close()
			t.Fatal(err)
		}
		select {
		case got := <-observed.committed:
			if got != pts {
				t.Error("wrong checkpoint")
			}
		case <-parent.Done():
			t.Error("commit timeout")
		}
		f.Close()
		select {
		case err := <-done:
			if err != nil && !errors.Is(err, context.Canceled) {
				t.Error(err)
			}
		case <-parent.Done():
			t.Error("shutdown timeout")
		}
		if err := s.Close(); err != nil {
			t.Fatal(err)
		}
	}
	s, err := inbox.Open(parent, path, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	state, found, err := s.GetState(parent, 101)
	if err != nil || !found || state.Pts != 12 {
		t.Fatalf("final checkpoint: %+v %v", state, err)
	}
	events, err := s.Pending(parent, 10)
	if err != nil || len(events) != 2 {
		t.Fatalf("persistent events=%d err=%v", len(events), err)
	}
}
