package telegramio

import (
	"context"
	"errors"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/updates"
	"github.com/gotd/td/tg"
	"telebox.local/rewrite-probe/inbox"
)

func runtimeFixtureStore(t *testing.T, ctx context.Context) *inbox.Store {
	t.Helper()
	s, err := inbox.Open(ctx, filepath.Join(t.TempDir(), "runtime.sqlite"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	if err := s.SetState(ctx, 101, updates.State{Pts: 10, Date: 100}); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestRuntimeRejectsUnorderedAdmissionAndStopsConsumer(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s := runtimeFixtureStore(t, ctx)
	failure := errors.New("injected ingress failure")
	consumerStarted := make(chan struct{})
	var consumerStopped atomic.Bool
	r, err := NewUpdateRuntime(101, s, telegram.UpdateHandlerFunc(func(context.Context, tg.UpdatesClass) error { return failure }), func(ctx context.Context) error {
		close(consumerStarted)
		<-ctx.Done()
		consumerStopped.Store(true)
		return ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	update := &tg.UpdateShort{Date: 100, Update: &tg.UpdateDeleteMessages{Messages: []int{12}, Pts: 11, PtsCount: 1}}
	if err := r.Handle(ctx, update); !errors.Is(err, ErrRuntimeNotReady) {
		t.Fatal("startup bypass allowed", err)
	}
	done := make(chan error, 1)
	go func() { done <- r.Run(ctx, auditAPI{}) }()
	select {
	case <-consumerStarted:
	case <-ctx.Done():
		t.Fatal("consumer start timeout")
	}
	if err := r.Handle(ctx, update); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if !errors.Is(err, failure) {
			t.Fatal("ingress cause lost", err)
		}
	case <-ctx.Done():
		t.Fatal("runtime stop timeout")
	}
	if !consumerStopped.Load() {
		t.Fatal("runtime returned before consumer stopped")
	}
	state, _, err := s.GetState(ctx, 101)
	if err != nil || state.Pts != 10 {
		t.Fatal("failed ingress advanced checkpoint", err)
	}
	if err := r.Handle(ctx, update); !errors.Is(err, ErrRuntimeNotReady) {
		t.Fatal(err)
	}
	if err := r.Run(ctx, auditAPI{}); !errors.Is(err, ErrRuntimeUsed) {
		t.Fatal("runtime reused after failure", err)
	}
}

func TestRuntimeConsumerFailureCancelsManager(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s := runtimeFixtureStore(t, ctx)
	if _, err := s.Put(ctx, "101", "pending-fixture", []byte("payload")); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("injected business failure")
	c, err := inbox.NewConsumer(s, func(context.Context, inbox.Event) error { return failure })
	if err != nil {
		t.Fatal(err)
	}
	r, err := NewUpdateRuntime(101, s, telegram.UpdateHandlerFunc(func(context.Context, tg.UpdatesClass) error { return nil }), func(ctx context.Context) error { return c.Run(ctx, 10, time.Millisecond) })
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Run(ctx, auditAPI{}); !errors.Is(err, failure) {
		t.Fatal("business failure lost", err)
	}
	pending, err := s.Pending(ctx, 10)
	if err != nil || len(pending) != 1 {
		t.Fatal("failed business event acknowledged", err)
	}
}

func TestRuntimeRequiresInitialAndChannelStatePolicy(t *testing.T) {
	for _, mode := range []string{"account", "channel"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			s, err := inbox.Open(ctx, filepath.Join(t.TempDir(), "runtime.sqlite"), 1024)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			want := ErrInitialStateRequired
			if mode == "channel" {
				if err := s.SetState(ctx, 101, updates.State{Pts: 10, Date: 100}); err != nil {
					t.Fatal(err)
				}
				if err := s.SetChannelPts(ctx, 101, 202, 3); err != nil {
					t.Fatal(err)
				}
				want = ErrResyncRequired
			}
			r, err := NewUpdateRuntime(101, s, telegram.UpdateHandlerFunc(func(context.Context, tg.UpdatesClass) error { t.Error("unexpected ingress"); return nil }), func(context.Context) error { t.Error("unexpected consumer"); return nil })
			if err != nil {
				t.Fatal(err)
			}
			if err := r.Run(ctx, auditAPI{}); !errors.Is(err, want) {
				t.Fatal(err)
			}
			select {
			case <-r.Ready():
				t.Fatal("incomplete state became ready")
			default:
			}
		})
	}
}
