package schedule

import (
	"context"
	"errors"
	"sync"

	"telebox.local/rewrite-probe/lifecycle"
)

var ErrDuplicate = errors.New("scheduled name already registered")

type Registry struct {
	mu     sync.Mutex
	g      *lifecycle.Generation
	jobs   map[string]*Registration
	closed bool
}

type Registration struct {
	Job      *Job
	name     string
	registry *Registry
}

func NewRegistry(g *lifecycle.Generation) *Registry {
	r := &Registry{g: g, jobs: make(map[string]*Registration)}
	g.Register("schedule-registry", func() error { r.Close(); return nil })
	return r
}

// Add preserves the first registration on duplicate names. A rejected caller
// receives no handle that could dispose the existing registration.
func (r *Registry) Add(name string, dates NextDate, handler func(context.Context) error) (*Registration, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil, lifecycle.ErrStopped
	}
	if _, exists := r.jobs[name]; exists {
		return nil, ErrDuplicate
	}
	job, err := StartJob(r.g, name, dates, handler)
	if err != nil {
		return nil, err
	}
	entry := &Registration{Job: job, name: name, registry: r}
	r.jobs[name] = entry
	return entry, nil
}

// Close removes only this registration, not a newer job with the same name.
func (entry *Registration) Close() {
	r := entry.registry
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.jobs[entry.name] == entry {
		entry.Job.Stop()
		delete(r.jobs, entry.name)
	}
}

func (r *Registry) Remove(name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, exists := r.jobs[name]
	if !exists {
		return false
	}
	entry.Job.Stop()
	delete(r.jobs, name)
	return true
}

func (r *Registry) Snapshot() map[string]JobReport {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := make(map[string]JobReport, len(r.jobs))
	for name, entry := range r.jobs {
		result[name] = entry.Job.Snapshot()
	}
	return result
}

// Close stops future ticks; Generation.Drain owns waiting for in-flight work.
func (r *Registry) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	for name, entry := range r.jobs {
		entry.Job.Stop()
		delete(r.jobs, name)
	}
}
