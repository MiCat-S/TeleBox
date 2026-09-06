package schedule

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"
	"time"

	"telebox.local/rewrite-probe/lifecycle"
)

type dateFunc func(time.Time) (time.Time, error)

func (f dateFunc) Next(t time.Time) (time.Time, error) { return f(t) }

var everySecond = dateFunc(func(t time.Time) (time.Time, error) { return t.Add(time.Second), nil })

func drainGeneration(t *testing.T, g *lifecycle.Generation) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	report, err := g.Drain(ctx)
	if err != nil || !report.Completed {
		t.Fatalf("drain: %+v %v", report, err)
	}
}

func TestJobSkipsOverlapAndTracksStoppedExecution(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		g := lifecycle.New(context.Background())
		release := make(chan struct{})
		j, err := StartJob(g, "slow", everySecond, func(context.Context) error { <-release; return nil })
		if err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		time.Sleep(3500 * time.Millisecond)
		synctest.Wait()
		if r := j.Snapshot(); r.Started != 1 || r.Skipped != 2 || !r.Running {
			t.Fatalf("overlap: %+v", r)
		}
		j.Stop()
		<-j.Done()
		if g.Snapshot().PendingTasks != 1 {
			t.Fatal("active execution lost on job stop")
		}
		close(release)
		synctest.Wait()
		time.Sleep(3 * time.Second)
		if r := j.Snapshot(); r.Started != 1 || r.Finished != 1 || r.Running {
			t.Fatalf("stopped job: %+v", r)
		}
		drainGeneration(t, g)
	})
}

func TestJobPanicReleasesOverlapGuard(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		g := lifecycle.New(context.Background())
		calls := 0
		j, err := StartJob(g, "panic", everySecond, func(context.Context) error {
			calls++
			if calls == 1 {
				panic("synthetic")
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		time.Sleep(2500 * time.Millisecond)
		synctest.Wait()
		if r := j.Snapshot(); r.Started != 2 || r.Finished != 2 || r.Failed != 1 || r.LastError == nil {
			t.Fatalf("panic tracking: %+v", r)
		}
		drainGeneration(t, g)
	})
}

func TestJobGenerationCancelStopsTimerAndExecution(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		g := lifecycle.New(context.Background())
		j, err := StartJob(g, "cancel", everySecond, func(ctx context.Context) error { <-ctx.Done(); return ctx.Err() })
		if err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		time.Sleep(1500 * time.Millisecond)
		synctest.Wait()
		drainGeneration(t, g)
		if r := j.Snapshot(); !r.Stopped || r.Running || r.Started != 1 || r.Finished != 1 || r.Failed != 0 {
			t.Fatalf("cancel tracking: %+v", r)
		}
	})
}

func TestJobDateErrorStopsLoop(t *testing.T) {
	for _, dates := range []dateFunc{
		func(t time.Time) (time.Time, error) { return t, nil },
		func(time.Time) (time.Time, error) { return time.Time{}, errors.New("date failure") },
		func(time.Time) (time.Time, error) { panic("synthetic date panic") },
	} {
		synctest.Test(t, func(t *testing.T) {
			g := lifecycle.New(context.Background())
			j, err := StartJob(g, "invalid", dates, func(context.Context) error { t.Error("invalid schedule executed"); return nil })
			if err != nil {
				t.Fatal(err)
			}
			<-j.Done()
			if r := j.Snapshot(); r.LastError == nil || !r.Stopped || r.Started != 0 {
				t.Fatalf("date error hidden: %+v", r)
			}
			drainGeneration(t, g)
		})
	}
}

func TestJobStopBeforeFirstTick(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		g := lifecycle.New(context.Background())
		j, err := StartJob(g, "stopped", everySecond, func(context.Context) error { t.Error("stopped job ran"); return nil })
		if err != nil {
			t.Fatal(err)
		}
		j.Stop()
		j.Stop()
		<-j.Done()
		time.Sleep(10 * time.Second)
		if r := j.Snapshot(); !r.Stopped || r.Started != 0 {
			t.Fatalf("unexpected execution: %+v", r)
		}
		drainGeneration(t, g)
		if _, err := StartJob(g, "late", everySecond, nil); !errors.Is(err, lifecycle.ErrStopped) {
			t.Fatal("stopped generation accepted timer")
		}
	})
}
