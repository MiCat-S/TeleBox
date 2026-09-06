package lifecycle

import (
	"context"
	"errors"
	"sync"
)

var ErrQueueFull = errors.New("executor queue is full")

type work struct {
	fn     func(context.Context) error
	result chan error
}

// Executor bounds running and queued work. Submit never creates a goroutine;
// the caller must handle ErrQueueFull explicitly (retry, persist, or report).
type Executor struct {
	mu         sync.Mutex
	g          *Generation
	queue      []*work
	head, size int
	stopped    bool
	changed    chan struct{}
}

func NewExecutor(g *Generation, workers, capacity int) (*Executor, error) {
	if workers < 1 || capacity < 1 {
		return nil, errors.New("workers and capacity must be positive")
	}
	e := &Executor{g: g, queue: make([]*work, capacity), changed: make(chan struct{})}
	for i := 0; i < workers; i++ {
		if _, err := g.Run("executor-worker", e.run); err != nil {
			e.stop()
			return nil, err
		}
	}
	g.Register("executor-queue", func() error { e.stop(); return nil })
	return e, nil
}

func (e *Executor) notifyLocked() {
	close(e.changed)
	e.changed = make(chan struct{})
}

func (e *Executor) Submit(fn func(context.Context) error) (<-chan error, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.stopped || e.g.ctx.Err() != nil || e.g.Snapshot().State != Active {
		return nil, ErrStopped
	}
	if e.size == len(e.queue) {
		return nil, ErrQueueFull
	}
	w := &work{fn: fn, result: make(chan error, 1)}
	e.queue[(e.head+e.size)%len(e.queue)] = w
	e.size++
	e.notifyLocked()
	return w.result, nil
}

func (e *Executor) popLocked() *work {
	w := e.queue[e.head]
	e.queue[e.head] = nil
	e.head = (e.head + 1) % len(e.queue)
	e.size--
	return w
}

func finish(w *work, err error) {
	w.result <- err
	close(w.result)
}

func (e *Executor) stop() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.stopped = true
	for e.size > 0 {
		finish(e.popLocked(), ErrStopped)
	}
	e.notifyLocked()
}

func (e *Executor) run(ctx context.Context) error {
	for {
		e.mu.Lock()
		if e.stopped || ctx.Err() != nil || e.g.Snapshot().State != Active {
			e.mu.Unlock()
			e.stop()
			return nil
		}
		if e.size > 0 {
			w := e.popLocked()
			e.mu.Unlock()
			finish(w, protected(func() error { return w.fn(ctx) }))
			continue
		}
		changed := e.changed
		e.mu.Unlock()
		select {
		case <-changed:
		case <-ctx.Done():
		}
	}
}
