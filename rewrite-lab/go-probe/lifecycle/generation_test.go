package lifecycle

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func deadline(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func drainOK(t *testing.T, g *Generation) {
	t.Helper()
	report, err := g.Drain(deadline(t))
	if err != nil || !report.Completed || report.PendingTasks != 0 || report.PendingResources != 0 {
		t.Fatalf("drain failed: %+v, %v", report, err)
	}
}

func TestCancellationSweepsLateResource(t *testing.T) {
	g := New(context.Background())
	var cleaned atomic.Int32
	task, err := g.Run("wait", func(ctx context.Context) error {
		<-ctx.Done()
		g.Register("late", func() error { cleaned.Add(1); return nil })
		return ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	drainOK(t, g)
	if !errors.Is(<-task, context.Canceled) || cleaned.Load() != 1 {
		t.Fatal("late cleanup missing")
	}
	if _, err := g.Run("rejected", func(context.Context) error { return nil }); !errors.Is(err, ErrStopped) {
		t.Fatal("work admitted after stop")
	}
}

func TestNestedAndPostDrainResources(t *testing.T) {
	g := New(context.Background())
	var cleaned atomic.Int32
	g.Register("outer", func() error {
		g.Register("inner", func() error { cleaned.Add(1); return nil })
		cleaned.Add(1)
		return nil
	})
	drainOK(t, g)
	late := g.Register("post-drain", func() error { cleaned.Add(1); return nil })
	if err := late.Close(deadline(t)); err != nil {
		t.Fatal(err)
	}
	drainOK(t, g)
	if cleaned.Load() != 3 {
		t.Fatal("nested resource leaked")
	}
}

func TestConcurrentCloseIsExactlyOnce(t *testing.T) {
	g := New(context.Background())
	var calls atomic.Int32
	resource := g.Register("once", func() error { calls.Add(1); return nil })
	ctx := deadline(t)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := resource.Close(ctx); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	drainOK(t, g)
	if calls.Load() != 1 {
		t.Fatal("cleanup repeated")
	}
}

func TestBoundedDrainRetainsUncooperativeCleanup(t *testing.T) {
	g := New(context.Background())
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	g.Register("blocked", func() error { close(started); <-release; return nil })
	g.RequestStop()
	select {
	case <-started:
	case <-deadline(t).Done():
		t.Fatal("cleanup did not start")
	}
	short, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	report, err := g.Drain(short)
	if !errors.Is(err, context.DeadlineExceeded) || report.Completed || report.PendingResources != 1 {
		t.Fatalf("timeout hidden: %+v %v", report, err)
	}
	unblock()
	drainOK(t, g)
}

func TestFailuresAndPanicsAreReported(t *testing.T) {
	g := New(context.Background())
	result, err := g.Run("bad-task", func(context.Context) error { panic("synthetic task failure") })
	if err != nil {
		t.Fatal(err)
	}
	if err := <-result; err == nil {
		t.Fatal("task panic hidden")
	}
	g.Register("bad-resource", func() error { panic("synthetic cleanup failure") })
	report, err := g.Drain(deadline(t))
	if err != nil || report.Completed || len(report.Errors) != 1 || len(report.TaskErrors) != 1 || report.State != Disposed {
		t.Fatalf("failures lost: %+v %v", report, err)
	}
	if !strings.Contains(report.TaskErrors[0].Error(), "bad-task") {
		t.Fatal("task label lost")
	}
	g.Register("late-failure", func() error { return errors.New("late") })
	report, err = g.Drain(deadline(t))
	if err != nil || len(report.Errors) != 2 || len(report.TaskErrors) != 1 {
		t.Fatalf("late failure lost: %+v %v", report, err)
	}
}

func TestTaskFailureDoesNotPreventDrain(t *testing.T) {
	g := New(context.Background())
	failure := errors.New("command failed")
	result, err := g.Run("command", func(context.Context) error { return failure })
	if err != nil {
		t.Fatal(err)
	}
	if !errors.Is(<-result, failure) {
		t.Fatal("command result lost")
	}
	report, err := g.Drain(deadline(t))
	if err != nil || !report.Completed || len(report.Errors) != 0 || len(report.TaskErrors) != 1 || !errors.Is(report.TaskErrors[0], failure) {
		t.Fatalf("task failure prevented cleanup: %+v %v", report, err)
	}
}

func TestBoundedDrainRetainsUncooperativeTask(t *testing.T) {
	g := New(context.Background())
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	result, err := g.Run("blocked-task", func(context.Context) error {
		close(started)
		<-release
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-deadline(t).Done():
		t.Fatal("task did not start")
	}
	short, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	report, err := g.Drain(short)
	if !errors.Is(err, context.DeadlineExceeded) || report.Completed || report.State != Draining || report.PendingTasks != 1 {
		t.Fatalf("live task hidden: %+v %v", report, err)
	}
	unblock()
	drainOK(t, g)
	if err := <-result; err != nil {
		t.Fatal(err)
	}
}

func TestTaskRequestsStopWithoutSelfDrain(t *testing.T) {
	g := New(context.Background())
	result, err := g.Run("reload-command", func(ctx context.Context) error {
		if _, err := g.Drain(ctx); !errors.Is(err, ErrSelfDrain) {
			return errors.New("self drain not rejected")
		}
		g.RequestStop()
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-deadline(t).Done():
		t.Fatal("self drain deadlocked")
	}
	drainOK(t, g)
}

func TestConcurrentAdmissionAndStop(t *testing.T) {
	g := New(context.Background())
	var admitted, executed atomic.Int32
	var submitters sync.WaitGroup
	for i := 0; i < 100; i++ {
		submitters.Add(1)
		go func() {
			defer submitters.Done()
			_, err := g.Run("racing", func(context.Context) error { executed.Add(1); return nil })
			if err == nil {
				admitted.Add(1)
			} else if !errors.Is(err, ErrStopped) {
				t.Error(err)
			}
		}()
	}
	g.RequestStop()
	submitters.Wait()
	drainOK(t, g)
	if admitted.Load() != executed.Load() {
		t.Fatal("admitted work lost")
	}
}
