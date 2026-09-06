package telegramio

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"

	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/updates"
	"github.com/gotd/td/tg"
	"telebox.local/rewrite-probe/lifecycle"
)

type auditStorage struct {
	mu      sync.Mutex
	state   updates.State
	failPTS bool
}

func (s *auditStorage) GetState(context.Context, int64) (updates.State, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state, true, nil
}
func (s *auditStorage) mutate(f func(*updates.State)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	f(&s.state)
	return nil
}
func (s *auditStorage) SetState(_ context.Context, _ int64, v updates.State) error {
	return s.mutate(func(s *updates.State) { *s = v })
}
func (s *auditStorage) SetPts(_ context.Context, _ int64, v int) error {
	if s.failPTS {
		return errors.New("synthetic checkpoint write failure")
	}
	return s.mutate(func(s *updates.State) { s.Pts = v })
}
func (s *auditStorage) SetQts(_ context.Context, _ int64, v int) error {
	return s.mutate(func(s *updates.State) { s.Qts = v })
}
func (s *auditStorage) SetDate(_ context.Context, _ int64, v int) error {
	return s.mutate(func(s *updates.State) { s.Date = v })
}
func (s *auditStorage) SetSeq(_ context.Context, _ int64, v int) error {
	return s.mutate(func(s *updates.State) { s.Seq = v })
}
func (s *auditStorage) SetDateSeq(_ context.Context, _ int64, date, seq int) error {
	return s.mutate(func(s *updates.State) { s.Date = date; s.Seq = seq })
}
func (*auditStorage) GetChannelPts(context.Context, int64, int64) (int, bool, error) {
	return 0, false, errors.New("unexpected channel lookup")
}
func (*auditStorage) SetChannelPts(context.Context, int64, int64, int) error {
	return errors.New("unexpected channel write")
}
func (*auditStorage) ForEachChannels(context.Context, int64, func(context.Context, int64, int) error) error {
	return nil
}

type auditAPI struct{}

func (auditAPI) UpdatesGetState(context.Context) (*tg.UpdatesState, error) {
	return nil, errors.New("unexpected remote state fetch")
}
func (auditAPI) UpdatesGetDifference(context.Context, *tg.UpdatesGetDifferenceRequest) (tg.UpdatesDifferenceClass, error) {
	return &tg.UpdatesDifferenceEmpty{Date: 100}, nil
}
func (auditAPI) UpdatesGetChannelDifference(context.Context, *tg.UpdatesGetChannelDifferenceRequest) (tg.UpdatesChannelDifferenceClass, error) {
	return nil, errors.New("unexpected channel difference")
}

// This is a known-risk audit, not a passing reliable-delivery guarantee.
func TestManagerAdvancesPTSAfterHandlerRejection(t *testing.T) {
	auditManagerCheckpoint(t, true, false)
}

func TestManagerDoesNotRetryAfterCheckpointWriteFailure(t *testing.T) {
	auditManagerCheckpoint(t, false, true)
}

func auditManagerCheckpoint(t *testing.T, reject, failCheckpoint bool) {
	t.Helper()
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		storage := &auditStorage{state: updates.State{Pts: 10, Date: 100}, failPTS: failCheckpoint}
		var calls atomic.Int32
		manager := updates.New(updates.Config{
			Storage: storage,
			Handler: telegram.UpdateHandlerFunc(func(context.Context, tg.UpdatesClass) error {
				calls.Add(1)
				if reject {
					return lifecycle.ErrQueueFull
				}
				return nil
			}),
		})
		started := make(chan struct{})
		done := make(chan error, 1)
		go func() {
			done <- manager.Run(ctx, auditAPI{}, 101, updates.AuthOptions{OnStart: func(context.Context) { close(started) }})
		}()
		<-started
		synctest.Wait()
		update := &tg.UpdateShort{Date: 100, Update: &tg.UpdateDeleteMessages{Messages: []int{12}, Pts: 11, PtsCount: 1}}
		if err := manager.Handle(ctx, update); err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		state, _, err := storage.GetState(ctx, 101)
		wantPTS := 11
		if failCheckpoint {
			wantPTS = 10
		}
		if err != nil || state.Pts != wantPTS || calls.Load() != 1 {
			t.Fatalf("behavior changed: pts=%d calls=%d err=%v", state.Pts, calls.Load(), err)
		}
		if err := manager.Handle(ctx, update); err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		if calls.Load() != 1 {
			t.Fatal("duplicate was redelivered; review integration assumptions")
		}
		t.Logf("UNRESOLVED: rejected=%v checkpointFailure=%v storedPTS=%d; replaying the same update did not retry the handler", reject, failCheckpoint, state.Pts)
		cancel()
		if err := <-done; err != nil && !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	})
}
