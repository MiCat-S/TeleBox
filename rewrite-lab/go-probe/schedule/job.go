package schedule

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"telebox.local/rewrite-probe/lifecycle"
)

type NextDate interface {
	Next(time.Time) (time.Time, error)
}

type JobReport struct {
	Running, Stopped                   bool
	Started, Finished, Skipped, Failed uint64
	LastError                          error
}

type Job struct {
	mu       sync.Mutex
	report   JobReport
	stop     chan struct{}
	done     chan struct{}
	once     sync.Once
	disabled bool
}

// StartJob starts a generation-owned timer loop. The date provider is separate
// so compatibility can be verified before any business task is installed.
func StartJob(g *lifecycle.Generation, name string, dates NextDate, handler func(context.Context) error) (*Job, error) {
	j := &Job{stop: make(chan struct{}), done: make(chan struct{})}
	_, err := g.Run("schedule:"+name, func(ctx context.Context) (loopErr error) {
		defer func() {
			if value := recover(); value != nil {
				loopErr = fmt.Errorf("date provider panic: %v", value)
			}
			j.mu.Lock()
			j.report.Stopped = true
			if loopErr != nil {
				j.report.LastError = loopErr
			}
			j.mu.Unlock()
			close(j.done)
		}()
		for {
			if ctx.Err() != nil {
				return nil
			}
			select {
			case <-j.stop:
				return nil
			default:
			}
			now := time.Now()
			next, err := dates.Next(now)
			if err != nil {
				return err
			}
			if !next.After(now) {
				return errors.New("schedule returned a non-future date")
			}
			timer := time.NewTimer(time.Until(next))
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil
			case <-j.stop:
				timer.Stop()
				return nil
			case <-timer.C:
			}
			select {
			case <-j.stop:
				return nil
			default:
			}
			if ctx.Err() != nil {
				return nil
			}
			j.mu.Lock()
			if j.disabled {
				j.mu.Unlock()
				return nil
			}
			if j.report.Running {
				j.report.Skipped++
				j.mu.Unlock()
				continue
			}
			j.report.Running = true
			j.report.Started++
			j.mu.Unlock()
			_, err = g.Run("scheduled-task:"+name, func(taskCtx context.Context) (err error) {
				defer func() {
					if value := recover(); value != nil {
						err = fmt.Errorf("scheduled handler panic: %v", value)
					}
					j.mu.Lock()
					j.report.Running = false
					j.report.Finished++
					if err != nil && !errors.Is(err, context.Canceled) {
						j.report.Failed++
						j.report.LastError = err
					}
					j.mu.Unlock()
				}()
				return handler(taskCtx)
			})
			if err != nil {
				j.mu.Lock()
				j.report.Running = false
				j.report.Started--
				j.mu.Unlock()
				if errors.Is(err, lifecycle.ErrStopped) {
					return nil
				}
				return err
			}
		}
	})
	if err != nil {
		return nil, err
	}
	return j, nil
}

// Stop disables future ticks. An already admitted execution remains tracked
// by the generation and is canceled when that generation stops.
func (j *Job) Stop() {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.disabled = true
	j.once.Do(func() { close(j.stop) })
}
func (j *Job) Done() <-chan struct{} { return j.done }
func (j *Job) Snapshot() JobReport {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.report
}
