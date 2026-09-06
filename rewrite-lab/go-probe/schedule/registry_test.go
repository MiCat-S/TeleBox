package schedule

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"telebox.local/rewrite-probe/lifecycle"
)

func TestRegistryDuplicatePreservesFirst(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		g := lifecycle.New(context.Background())
		r := NewRegistry(g)
		var calls atomic.Int32
		first, err := r.Add("sum:1", everySecond, func(context.Context) error { calls.Add(1); return nil })
		if err != nil {
			t.Fatal(err)
		}
		duplicate, err := r.Add("sum:1", everySecond, func(context.Context) error { t.Error("duplicate ran"); return nil })
		if !errors.Is(err, ErrDuplicate) || duplicate != nil {
			t.Fatal("duplicate replaced original")
		}
		synctest.Wait()
		time.Sleep(1500 * time.Millisecond)
		synctest.Wait()
		if calls.Load() != 1 || first.Job.Snapshot().Started != 1 || len(r.Snapshot()) != 1 {
			t.Fatal("first task lost")
		}
		drainGeneration(t, g)
	})
}

func TestRegistryOldHandleCannotRemoveReplacement(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		g := lifecycle.New(context.Background())
		r := NewRegistry(g)
		old, err := r.Add("sum:1", everySecond, func(context.Context) error { return nil })
		if err != nil {
			t.Fatal(err)
		}
		if !r.Remove("sum:1") || r.Remove("sum:1") {
			t.Fatal("remove result wrong")
		}
		next, err := r.Add("sum:1", everySecond, func(context.Context) error { return nil })
		if err != nil {
			t.Fatal(err)
		}
		old.Close()
		old.Close()
		synctest.Wait()
		time.Sleep(1500 * time.Millisecond)
		synctest.Wait()
		if next.Job.Snapshot().Started != 1 || len(r.Snapshot()) != 1 {
			t.Fatal("stale handle removed replacement")
		}
		next.Close()
		if len(r.Snapshot()) != 0 {
			t.Fatal("current handle failed to remove")
		}
		drainGeneration(t, g)
	})
}

func TestRegistryGenerationDrainClosesAdmissions(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		g := lifecycle.New(context.Background())
		r := NewRegistry(g)
		entry, err := r.Add("nodeseek", everySecond, func(ctx context.Context) error { <-ctx.Done(); return ctx.Err() })
		if err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		time.Sleep(1500 * time.Millisecond)
		synctest.Wait()
		r.Remove("nodeseek")
		<-entry.Job.Done()
		if g.Snapshot().PendingTasks != 1 {
			t.Fatal("removed active task lost")
		}
		drainGeneration(t, g)
		if len(r.Snapshot()) != 0 {
			t.Fatal("registry survived shutdown")
		}
		if _, err := r.Add("new", everySecond, nil); !errors.Is(err, lifecycle.ErrStopped) {
			t.Fatal("closed registry accepted task")
		}
	})
}

func TestRegistryConcurrentDuplicateAdmission(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		g := lifecycle.New(context.Background())
		r := NewRegistry(g)
		var winners atomic.Int32
		var wg sync.WaitGroup
		for i := 0; i < 50; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, err := r.Add("same", everySecond, func(context.Context) error { return nil })
				if err == nil {
					winners.Add(1)
				} else if !errors.Is(err, ErrDuplicate) {
					t.Error(err)
				}
			}()
		}
		wg.Wait()
		if winners.Load() != 1 || len(r.Snapshot()) != 1 {
			t.Fatal("concurrent registration duplicated")
		}
		drainGeneration(t, g)
	})
}

func TestRegistryAcrossSupervisorReloads(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := lifecycle.NewSupervisor(context.Background())
		var previous *Registry
		var previousCount *atomic.Int32
		for i := 0; i < 5; i++ {
			var current *Registry
			calls := &atomic.Int32{}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			_, err := s.Reload(ctx, func(_ context.Context, g *lifecycle.Generation) error {
				current = NewRegistry(g)
				_, err := current.Add("sum:1", everySecond, func(context.Context) error { calls.Add(1); return nil })
				return err
			})
			cancel()
			if err != nil {
				t.Fatal(err)
			}
			if previous != nil && len(previous.Snapshot()) != 0 {
				t.Fatal("old registry was not cleared")
			}
			synctest.Wait()
			time.Sleep(1500 * time.Millisecond)
			synctest.Wait()
			if calls.Load() != 1 {
				t.Fatalf("new generation scheduled %d times", calls.Load())
			}
			if previousCount != nil && previousCount.Load() != 1 {
				t.Fatal("old generation kept ticking")
			}
			previous, previousCount = current, calls
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := s.Stop(ctx); err != nil {
			t.Fatal(err)
		}
	})
}
