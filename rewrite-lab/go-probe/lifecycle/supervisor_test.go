package lifecycle

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestReloadSerializesGenerations(t *testing.T) {
	s := NewSupervisor(context.Background())
	var active atomic.Int32
	var setups atomic.Int32
	setup := func(_ context.Context, g *Generation) error {
		if active.Add(1) != 1 {
			t.Error("generations overlapped")
		}
		setups.Add(1)
		g.Register("service", func() error { active.Add(-1); return nil })
		return nil
	}
	ctx := deadline(t)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.Reload(ctx, setup); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if _, ready := s.Current(); !ready || setups.Load() != 20 {
		t.Fatal("reload did not become ready")
	}
	if err := s.Stop(ctx); err != nil || active.Load() != 0 {
		t.Fatalf("service survived stop: %v", err)
	}
}

func TestFailedSetupCleansBeforeRetry(t *testing.T) {
	s := NewSupervisor(context.Background())
	failure := errors.New("setup failed")
	var cleaned atomic.Bool
	_, err := s.Reload(deadline(t), func(_ context.Context, g *Generation) error {
		g.Register("partial", func() error { cleaned.Store(true); return nil })
		return failure
	})
	g, ready := s.Current()
	if !errors.Is(err, failure) || !cleaned.Load() || ready || g == nil || !g.Snapshot().Completed {
		t.Fatalf("failed candidate lost or not cleaned: %v", err)
	}
	if _, err := s.Reload(deadline(t), func(context.Context, *Generation) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if err := s.Stop(deadline(t)); err != nil {
		t.Fatal(err)
	}
}

func TestCleanupFailurePreventsReplacement(t *testing.T) {
	s := NewSupervisor(context.Background())
	failure := errors.New("cleanup failed")
	g, err := s.Reload(deadline(t), func(_ context.Context, g *Generation) error {
		g.Register("failed", func() error { return failure })
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Reload(deadline(t), func(context.Context, *Generation) error {
		t.Error("replacement started after failed cleanup")
		return nil
	})
	current, ready := s.Current()
	if !errors.Is(err, failure) || !errors.Is(err, ErrIncompleteDrain) || current != g || ready {
		t.Fatalf("cleanup failure hidden: %v", err)
	}
}

func TestTimedOutSetupRemainsTracked(t *testing.T) {
	s := NewSupervisor(context.Background())
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	short, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := s.Reload(short, func(context.Context, *Generation) error { <-release; return nil })
	g, ready := s.Current()
	if !errors.Is(err, context.DeadlineExceeded) || ready || g == nil || g.Snapshot().PendingTasks != 1 {
		t.Fatalf("timed out setup hidden: %v", err)
	}
	short2, cancel2 := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel2()
	_, err = s.Reload(short2, func(context.Context, *Generation) error {
		t.Error("replacement overlapped timed out setup")
		return nil
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	unblock()
	if _, err := s.Reload(deadline(t), func(context.Context, *Generation) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if err := s.Stop(deadline(t)); err != nil {
		t.Fatal(err)
	}
}

func TestSetupCannotWaitOnOwnSupervisor(t *testing.T) {
	s := NewSupervisor(context.Background())
	_, err := s.Reload(deadline(t), func(ctx context.Context, _ *Generation) error {
		if err := s.Stop(ctx); !errors.Is(err, ErrSelfDrain) {
			return errors.New("self stop not rejected")
		}
		if _, err := s.Reload(ctx, nil); !errors.Is(err, ErrSelfDrain) {
			return errors.New("self reload not rejected")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Stop(deadline(t)); err != nil {
		t.Fatal(err)
	}
}

func TestQueuedTransitionCanCancel(t *testing.T) {
	s := NewSupervisor(context.Background())
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	done := make(chan error, 1)
	ctx := deadline(t)
	go func() {
		_, err := s.Reload(ctx, func(context.Context, *Generation) error {
			close(started)
			<-release
			return nil
		})
		done <- err
	}()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("setup not started")
	}
	short, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := s.Stop(short); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("queued stop ignored cancellation")
	}
	unblock()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, ready := s.Current(); !ready {
		t.Fatal("canceled stop changed current generation")
	}
	if err := s.Stop(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestGenerationLifetimeBelongsToParent(t *testing.T) {
	parent, cancelParent := context.WithCancel(context.Background())
	defer cancelParent()
	s := NewSupervisor(parent)
	request, cancelRequest := context.WithCancel(deadline(t))
	defer cancelRequest()
	g, err := s.Reload(request, func(context.Context, *Generation) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	cancelRequest()
	if _, ready := s.Current(); !ready {
		t.Fatal("request cancellation stopped running generation")
	}
	result, err := g.Run("service", func(ctx context.Context) error { <-ctx.Done(); return ctx.Err() })
	if err != nil {
		t.Fatal(err)
	}
	cancelParent()
	if _, ready := s.Current(); ready {
		t.Fatal("parent-canceled generation still ready")
	}
	if err := s.Stop(deadline(t)); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(<-result, context.Canceled) {
		t.Fatal("service cancellation missing")
	}
}

func TestFailedSetupCleanupErrorRemainsVisible(t *testing.T) {
	s := NewSupervisor(context.Background())
	setupFailure, cleanupFailure := errors.New("setup"), errors.New("cleanup")
	_, err := s.Reload(deadline(t), func(_ context.Context, g *Generation) error {
		g.Register("partial", func() error { return cleanupFailure })
		return setupFailure
	})
	if !errors.Is(err, setupFailure) || !errors.Is(err, cleanupFailure) || !errors.Is(err, ErrIncompleteDrain) {
		t.Fatalf("startup rollback error hidden: %v", err)
	}
	g, ready := s.Current()
	if g == nil || ready || len(g.Snapshot().Errors) != 1 {
		t.Fatal("failed candidate lost")
	}
	_, err = s.Reload(deadline(t), func(context.Context, *Generation) error {
		t.Error("replacement started after failed startup cleanup")
		return nil
	})
	if !errors.Is(err, cleanupFailure) {
		t.Fatal(err)
	}
}

func TestCommandFailureAllowsReload(t *testing.T) {
	s := NewSupervisor(context.Background())
	setup := func(context.Context, *Generation) error { return nil }
	g, err := s.Reload(deadline(t), setup)
	if err != nil {
		t.Fatal(err)
	}
	result, err := g.Run("command", func(context.Context) error { return errors.New("command failed") })
	if err != nil {
		t.Fatal(err)
	}
	if err := <-result; err == nil {
		t.Fatal("command error hidden")
	}
	next, err := s.Reload(deadline(t), setup)
	if err != nil || next == g || !g.Snapshot().Completed || len(g.Snapshot().TaskErrors) != 1 {
		t.Fatalf("command failure blocked reload: %v", err)
	}
	if err := s.Stop(deadline(t)); err != nil {
		t.Fatal(err)
	}
}
