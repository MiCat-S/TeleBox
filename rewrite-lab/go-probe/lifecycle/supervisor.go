package lifecycle

import (
	"context"
	"errors"
	"sync"
)

var ErrIncompleteDrain = errors.New("generation cleanup did not complete successfully")

type Setup func(context.Context, *Generation) error

// Supervisor serializes transitions. Setup must register resources and run
// background work through its generation, not detach untracked goroutines.
type Supervisor struct {
	parent  context.Context
	gate    chan struct{}
	mu      sync.Mutex
	current *Generation
	ready   bool
}

func NewSupervisor(parent context.Context) *Supervisor {
	return &Supervisor{parent: parent, gate: make(chan struct{}, 1)}
}

// Current includes a failed or draining candidate so cleanup remains observable.
func (s *Supervisor) Current() (*Generation, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.current, s.ready && s.current != nil && s.current.ctx.Err() == nil && s.current.Snapshot().State == Active
}

func (s *Supervisor) enter(ctx context.Context) error {
	s.mu.Lock()
	self := s.current != nil && ctx.Value(taskContextKey{}) == s.current
	s.mu.Unlock()
	if self {
		return ErrSelfDrain
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case s.gate <- struct{}{}:
		if err := ctx.Err(); err != nil {
			<-s.gate
			return err
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Supervisor) drain(ctx context.Context) error {
	s.mu.Lock()
	g := s.current
	s.ready = false
	s.mu.Unlock()
	if g == nil {
		return nil
	}
	report, err := g.Drain(ctx)
	if err != nil {
		return err
	}
	if !report.Completed {
		return errors.Join(append([]error{ErrIncompleteDrain}, report.Errors...)...)
	}
	return nil
}

// Reload waits for readiness, not the lifetime of background services. Its
// caller context bounds this transition; the parent owns the new generation.
func (s *Supervisor) Reload(ctx context.Context, setup Setup) (*Generation, error) {
	if err := s.enter(ctx); err != nil {
		return nil, err
	}
	defer func() { <-s.gate }()
	if err := s.drain(ctx); err != nil {
		return nil, err
	}
	if err := errors.Join(ctx.Err(), s.parent.Err()); err != nil {
		return nil, err
	}
	g := New(s.parent)
	s.mu.Lock()
	s.current = g
	s.mu.Unlock()
	result, err := g.Run("setup", func(taskCtx context.Context) error { return setup(taskCtx, g) })
	if err == nil {
		select {
		case err = <-result:
		case <-ctx.Done():
			err = ctx.Err()
		case <-s.parent.Done():
			err = s.parent.Err()
		}
	}
	if err == nil {
		err = errors.Join(ctx.Err(), s.parent.Err())
	}
	if err == nil && g.Snapshot().State != Active {
		err = ErrStopped
	}
	if err != nil {
		return nil, errors.Join(err, s.drain(ctx))
	}
	s.mu.Lock()
	s.ready = true
	s.mu.Unlock()
	return g, nil
}

// Stop may be retried after a timeout; it never drops an unfinished generation.
func (s *Supervisor) Stop(ctx context.Context) error {
	if err := s.enter(ctx); err != nil {
		return err
	}
	defer func() { <-s.gate }()
	return s.drain(ctx)
}
