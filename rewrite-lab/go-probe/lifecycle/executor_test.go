package lifecycle

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func outcome(t *testing.T, result <-chan error) error {
	t.Helper()
	select {
	case err, ok := <-result:
		if !ok {
			t.Fatal("missing result")
		}
		return err
	case <-deadline(t).Done():
		t.Fatal("result not delivered")
		return nil
	}
}

func TestExecutorBoundAndCancelQueuedWork(t *testing.T) {
	g := New(context.Background())
	e, err := NewExecutor(g, 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	running, err := e.Submit(func(ctx context.Context) error { close(started); <-ctx.Done(); return ctx.Err() })
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-deadline(t).Done():
		t.Fatal("worker not started")
	}
	var queued []<-chan error
	for i := 0; i < 2; i++ {
		result, err := e.Submit(func(context.Context) error { t.Error("queued work ran after stop"); return nil })
		if err != nil {
			t.Fatal(err)
		}
		queued = append(queued, result)
	}
	if result, err := e.Submit(nil); !errors.Is(err, ErrQueueFull) || result != nil {
		t.Fatal("queue limit not enforced")
	}
	drainOK(t, g)
	if !errors.Is(outcome(t, running), context.Canceled) {
		t.Fatal("running task not canceled")
	}
	for _, result := range queued {
		if !errors.Is(outcome(t, result), ErrStopped) {
			t.Fatal("queued cancellation missing")
		}
	}
	if _, err := e.Submit(nil); !errors.Is(err, ErrStopped) {
		t.Fatal("stopped executor accepted work")
	}
}

func TestExecutorPanicDoesNotLoseWorker(t *testing.T) {
	g := New(context.Background())
	e, err := NewExecutor(g, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	first, err := e.Submit(func(context.Context) error { panic("synthetic") })
	if err != nil {
		t.Fatal(err)
	}
	if outcome(t, first) == nil {
		t.Fatal("panic hidden")
	}
	second, err := e.Submit(func(context.Context) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if err := outcome(t, second); err != nil {
		t.Fatal(err)
	}
	drainOK(t, g)
}

func TestExecutorUncooperativeWorkBlocksReplacement(t *testing.T) {
	s := NewSupervisor(context.Background())
	var e *Executor
	g, err := s.Reload(deadline(t), func(_ context.Context, g *Generation) error {
		var err error
		e, err = NewExecutor(g, 1, 1)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	result, err := e.Submit(func(context.Context) error { close(started); <-release; return nil })
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-deadline(t).Done():
		t.Fatal("worker not started")
	}
	short, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err = s.Reload(short, func(context.Context, *Generation) error { t.Error("replacement overlapped worker"); return nil })
	if !errors.Is(err, context.DeadlineExceeded) || g.Snapshot().PendingTasks != 1 {
		t.Fatalf("blocked worker lost: %v %+v", err, g.Snapshot())
	}
	unblock()
	if err := outcome(t, result); err != nil {
		t.Fatal(err)
	}
	if err := s.Stop(deadline(t)); err != nil {
		t.Fatal(err)
	}
}

func TestExecutorConcurrentAdmissionHasOutcome(t *testing.T) {
	g := New(context.Background())
	e, err := NewExecutor(g, 4, 8)
	if err != nil {
		t.Fatal(err)
	}
	var executed, succeeded, canceled, rejected atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := e.Submit(func(context.Context) error { executed.Add(1); return nil })
			if errors.Is(err, ErrQueueFull) || errors.Is(err, ErrStopped) {
				rejected.Add(1)
				return
			}
			if err != nil {
				t.Error(err)
				return
			}
			select {
			case err := <-result:
				if err == nil {
					succeeded.Add(1)
				} else if errors.Is(err, ErrStopped) {
					canceled.Add(1)
				} else {
					t.Error(err)
				}
			case <-time.After(3 * time.Second):
				t.Error("accepted work lost")
			}
		}()
	}
	g.RequestStop()
	wg.Wait()
	drainOK(t, g)
	if executed.Load() != succeeded.Load() || succeeded.Load()+canceled.Load()+rejected.Load() != 100 {
		t.Fatal("admission/result accounting mismatch")
	}
}

func TestExecutorRejectsInvalidConfiguration(t *testing.T) {
	g := New(context.Background())
	for _, pair := range [][2]int{{0, 1}, {1, 0}, {-1, 1}} {
		if _, err := NewExecutor(g, pair[0], pair[1]); err == nil {
			t.Fatal("invalid bounds accepted")
		}
	}
	drainOK(t, g)
	if _, err := NewExecutor(g, 1, 1); !errors.Is(err, ErrStopped) {
		t.Fatal("executor started in disposed generation")
	}
}

func TestExecutorConcurrentWorkerLimit(t *testing.T) {
	g := New(context.Background())
	e, err := NewExecutor(g, 3, 6)
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{}, 3)
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	var active, peak atomic.Int32
	run := func(context.Context) error {
		n := active.Add(1)
		for old := peak.Load(); n > old; old = peak.Load() {
			if peak.CompareAndSwap(old, n) {
				break
			}
		}
		select {
		case started <- struct{}{}:
		default:
		}
		<-release
		active.Add(-1)
		return nil
	}
	var results []<-chan error
	for i := 0; i < 3; i++ {
		result, err := e.Submit(run)
		if err != nil {
			t.Fatal(err)
		}
		results = append(results, result)
	}
	for i := 0; i < 3; i++ {
		select {
		case <-started:
		case <-deadline(t).Done():
			t.Fatal("workers did not fill")
		}
	}
	for i := 0; i < 6; i++ {
		result, err := e.Submit(run)
		if err != nil {
			t.Fatal(err)
		}
		results = append(results, result)
	}
	if _, err := e.Submit(run); !errors.Is(err, ErrQueueFull) {
		t.Fatal("queue overflow")
	}
	unblock()
	for _, result := range results {
		if err := outcome(t, result); err != nil {
			t.Fatal(err)
		}
	}
	drainOK(t, g)
	if peak.Load() != 3 || active.Load() != 0 {
		t.Fatalf("invalid concurrency peak=%d active=%d", peak.Load(), active.Load())
	}
}
