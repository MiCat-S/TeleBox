// Package lifecycle is a candidate runtime experiment, not the production runtime.
package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

var ErrStopped = errors.New("generation is stopping")
var ErrSelfDrain = errors.New("tracked task must request stop; coordinator must drain")

type State string

const (
	Active   State = "active"
	Draining State = "draining"
	Disposed State = "disposed"
)

type Report struct {
	State            State
	Completed        bool
	PendingTasks     int
	PendingResources int
	Errors           []error
	TaskErrors       []error
}

type taskContextKey struct{}

type Generation struct {
	mu           sync.Mutex
	ctx          context.Context
	cancel       context.CancelFunc
	state        State
	tasks        int
	resources    map[*Resource]struct{}
	failures     []error
	taskFailures []error
	changed      chan struct{}
}

type Resource struct {
	generation *Generation
	cleanup    func() error
	label      string
	started    bool
	done       chan struct{}
	err        error
}

func New(parent context.Context) *Generation {
	ctx, cancel := context.WithCancel(parent)
	return &Generation{
		ctx: ctx, cancel: cancel, state: Active,
		resources: make(map[*Resource]struct{}), changed: make(chan struct{}),
	}
}

func (g *Generation) notifyLocked() {
	close(g.changed)
	g.changed = make(chan struct{})
}

func protected(fn func() error) (err error) {
	defer func() {
		if value := recover(); value != nil {
			err = fmt.Errorf("callback panic: %v", value)
		}
	}()
	return fn()
}

// Run returns the task's own result; Drain additionally reports failed tasks.
func (g *Generation) Run(label string, fn func(context.Context) error) (<-chan error, error) {
	g.mu.Lock()
	if g.state != Active || g.ctx.Err() != nil {
		g.mu.Unlock()
		return nil, ErrStopped
	}
	g.tasks++
	g.mu.Unlock()
	result := make(chan error, 1)
	go func() {
		ctx := context.WithValue(g.ctx, taskContextKey{}, g)
		err := protected(func() error { return fn(ctx) })
		g.mu.Lock()
		if err != nil && !errors.Is(err, context.Canceled) {
			g.taskFailures = append(g.taskFailures, fmt.Errorf("task %s: %w", label, err))
		}
		result <- err
		close(result)
		g.tasks--
		g.notifyLocked()
		g.mu.Unlock()
	}()
	return result, nil
}

// Register during or after draining immediately starts cleanup, still tracked.
func (g *Generation) Register(label string, cleanup func() error) *Resource {
	resource := &Resource{generation: g, label: label, cleanup: cleanup, done: make(chan struct{})}
	g.mu.Lock()
	g.resources[resource] = struct{}{}
	if g.state != Active {
		g.startResourceLocked(resource)
	}
	g.notifyLocked()
	g.mu.Unlock()
	return resource
}

func (g *Generation) startResourceLocked(resource *Resource) {
	if resource.started {
		return
	}
	resource.started = true
	// User cleanup never runs under the generation lock and cannot block Drain.
	go func() {
		err := protected(resource.cleanup)
		g.mu.Lock()
		resource.err = err
		resource.cleanup = nil
		if err != nil {
			g.failures = append(g.failures, fmt.Errorf("resource %s: %w", resource.label, err))
		}
		delete(g.resources, resource)
		close(resource.done)
		g.notifyLocked()
		g.mu.Unlock()
	}()
}

func (resource *Resource) Close(ctx context.Context) error {
	g := resource.generation
	g.mu.Lock()
	g.startResourceLocked(resource)
	g.mu.Unlock()
	select {
	case <-resource.done:
		return resource.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// RequestStop is non-blocking and may be called from a tracked command handler.
func (g *Generation) RequestStop() {
	g.mu.Lock()
	if g.state == Active {
		g.state = Draining
	}
	for resource := range g.resources {
		g.startResourceLocked(resource)
	}
	g.notifyLocked()
	g.mu.Unlock()
	g.cancel()
}

func (g *Generation) snapshotLocked() Report {
	return Report{
		State:        g.state,
		Completed:    g.state == Disposed && g.tasks == 0 && len(g.resources) == 0 && len(g.failures) == 0,
		PendingTasks: g.tasks, PendingResources: len(g.resources),
		Errors:     append([]error(nil), g.failures...),
		TaskErrors: append([]error(nil), g.taskFailures...),
	}
}

func (g *Generation) Snapshot() Report {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.snapshotLocked()
}

// Drain bounds the caller's wait, not arbitrary Go code execution. A timed-out
// cleanup remains tracked; a later Drain can verify its eventual completion.
func (g *Generation) Drain(ctx context.Context) (Report, error) {
	if ctx.Value(taskContextKey{}) == g {
		return g.Snapshot(), ErrSelfDrain
	}
	g.RequestStop()
	for {
		g.mu.Lock()
		if g.tasks == 0 && len(g.resources) == 0 {
			g.state = Disposed
			report := g.snapshotLocked()
			g.mu.Unlock()
			return report, nil
		}
		changed := g.changed
		g.mu.Unlock()
		select {
		case <-changed:
		case <-ctx.Done():
			return g.Snapshot(), ctx.Err()
		}
	}
}
