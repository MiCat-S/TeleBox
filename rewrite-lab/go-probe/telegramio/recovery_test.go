package telegramio

import (
	"context"
	"errors"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gotd/td/bin"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/updates"
	"github.com/gotd/td/tg"
	"telebox.local/rewrite-probe/command"
	"telebox.local/rewrite-probe/inbox"
)

type recoveryAPI struct {
	auditAPI
	calls *atomic.Int32
}

func (a recoveryAPI) UpdatesGetDifference(ctx context.Context, req *tg.UpdatesGetDifferenceRequest) (tg.UpdatesDifferenceClass, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if req.Pts != 10 {
		return nil, errors.New("recovery requested beyond durable checkpoint")
	}
	a.calls.Add(1)
	m := &tg.Message{ID: 12, Date: 100, Message: ".ping", Out: true, PeerID: &tg.PeerUser{UserID: 202}}
	m.SetFromID(&tg.PeerUser{UserID: 101})
	return &tg.UpdatesDifference{NewMessages: []tg.MessageClass{m}, State: tg.UpdatesState{Pts: 11, Date: 100}}, nil
}

type recoveryStorage struct {
	*inbox.Store
	committed chan struct{}
	failure   error
}

func (s recoveryStorage) SetState(ctx context.Context, uid int64, state updates.State) error {
	if s.failure != nil {
		return s.failure
	}
	if err := s.Store.SetState(ctx, uid, state); err != nil {
		return err
	}
	select {
	case s.committed <- struct{}{}:
	default:
	}
	return nil
}

func TestFailedIngressRecoversThroughNewManagerDifference(t *testing.T) {
	for _, checkpointFailure := range []bool{false, true} {
		name := "ingress-full"
		if checkpointFailure {
			name = "checkpoint-after-ingress"
		}
		t.Run(name, func(t *testing.T) { testDifferenceRecovery(t, checkpointFailure) })
	}
}

func testDifferenceRecovery(t *testing.T, checkpointFailure bool) {
	t.Helper()
	checkpointError := errors.New("injected checkpoint write failure")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	path := filepath.Join(t.TempDir(), "recovery.sqlite")
	var requests atomic.Int32
	for phase := 0; phase < 2; phase++ {
		quota := int64(1)
		if phase == 1 || checkpointFailure {
			quota = 1 << 20
		}
		s, err := inbox.Open(ctx, path, quota)
		if err != nil {
			t.Fatal(err)
		}
		if phase == 0 {
			if err := s.SetState(ctx, 101, updates.State{Pts: 10, Date: 100}); err != nil {
				s.Close()
				t.Fatal(err)
			}
		}
		state, found, err := s.GetState(ctx, 101)
		if err != nil || !found || state.Pts != 10 {
			s.Close()
			t.Fatalf("checkpoint not preserved: %+v %v", state, err)
		}
		f := NewFailureFence(ctx)
		observed := recoveryStorage{Store: s, committed: make(chan struct{}, 1)}
		if phase == 0 && checkpointFailure {
			observed.failure = checkpointError
		}
		hashes := HashStorage{ChannelAccessHasher: s, UserAccessHasher: s, Fence: f}
		manager := updates.New(updates.Config{
			Storage: CheckpointStorage{StateStorage: observed, Fence: f}, AccessHasher: hashes, UserAccessHasher: hashes,
			Handler: telegram.UpdateHandlerFunc(func(ctx context.Context, u tg.UpdatesClass) error {
				return f.Apply(ctx, func(ctx context.Context) error {
					b := new(bin.Buffer)
					if err := u.Encode(b); err != nil {
						return err
					}
					// Identity only for this one-message recovery fixture.
					_, err := s.Put(ctx, "101", "fixture:new-user-message:202:12", b.Buf)
					return err
				})
			}),
		})
		done := make(chan error, 1)
		go func() { done <- manager.Run(f.Context(), recoveryAPI{calls: &requests}, 101, updates.AuthOptions{}) }()
		if phase == 0 {
			select {
			case <-f.Context().Done():
			case <-ctx.Done():
				t.Error("failed ingress did not stop")
			}
			wantError := inbox.ErrFull
			if checkpointFailure {
				wantError = checkpointError
			}
			if !errors.Is(f.Err(), wantError) {
				t.Errorf("wrong ingress failure: %v", f.Err())
			}
		} else {
			select {
			case <-observed.committed:
			case <-ctx.Done():
				t.Error("recovered checkpoint not committed")
			}
			if f.Err() != nil {
				t.Errorf("recovery failed: %v", f.Err())
			}
		}
		f.Close()
		select {
		case err := <-done:
			if err != nil && !errors.Is(err, context.Canceled) {
				t.Error(err)
			}
		case <-ctx.Done():
			t.Error("manager failed to exit")
		}
		if phase == 0 {
			wantPending := 0
			if checkpointFailure {
				wantPending = 1
			}
			pending, err := s.Pending(ctx, 10)
			if err != nil || len(pending) != wantPending {
				t.Errorf("failed phase pending=%d want=%d err=%v", len(pending), wantPending, err)
			}
		}
		if err := s.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if requests.Load() != 2 {
		t.Fatalf("difference requests=%d want 2", requests.Load())
	}
	s, err := inbox.Open(ctx, path, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	state, _, err := s.GetState(ctx, 101)
	if err != nil || state.Pts != 11 {
		t.Fatalf("recovered checkpoint: %+v %v", state, err)
	}
	events, err := s.Pending(ctx, 10)
	if err != nil || len(events) != 1 {
		t.Fatalf("recovered events=%d err=%v", len(events), err)
	}
	calls := 0
	d := command.NewDispatcher([]string{"."}, nil, map[string]command.Entry{"ping": {Handler: func(context.Context, command.Invocation) error { calls++; return nil }}})
	consumer, err := inbox.NewConsumer(s, func(ctx context.Context, event inbox.Event) error {
		decoded, err := tg.DecodeUpdates(&bin.Buffer{Buf: event.Payload})
		if err != nil {
			return err
		}
		batch, ok := decoded.(*tg.Updates)
		if !ok || len(batch.Updates) != 1 {
			return errors.New("unexpected recovered payload")
		}
		e, err := NormalizeUpdate(batch.Updates[0])
		if err != nil {
			return err
		}
		called, err := d.Primary(ctx, e)
		if err != nil {
			return err
		}
		if !called {
			return errors.New("recovered command not dispatched")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if n, err := consumer.Process(ctx, 10); n != 1 || calls != 1 || err != nil {
		t.Fatalf("recovered completed=%d calls=%d err=%v", n, calls, err)
	}
	if pending, err := s.Pending(ctx, 10); err != nil || len(pending) != 0 {
		t.Fatal("completion not recorded")
	}
}
