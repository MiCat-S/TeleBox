package telegramio

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"

	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/updates"
	"github.com/gotd/td/tg"
	"golang.org/x/sync/errgroup"
)

var ErrRuntimeNotReady = errors.New("update runtime is not accepting updates")
var ErrRuntimeUsed = errors.New("update runtime already started; recovery requires a new instance")
var ErrInitialStateRequired = errors.New("explicit initial account synchronization required")
var ErrResyncRequired = errors.New("update history requires explicit resynchronization")

type DurableState interface {
	updates.StateStorage
	updates.UserAccessHasher
	updates.ChannelAccessHasher
}

// UpdateRuntime owns one Manager and consumer lifetime, not the Telegram
// connection or database. Run must be tracked by the application's generation.
// Record must durably commit before returning and must not re-enter its fence.
type UpdateRuntime struct {
	account   int64
	storage   DurableState
	record    telegram.UpdateHandler
	consume   func(context.Context) error
	started   atomic.Bool
	ready     chan struct{}
	mu        sync.Mutex
	manager   *updates.Manager
	ctx       context.Context
	accepting bool
}

func NewUpdateRuntime(account int64, storage DurableState, record telegram.UpdateHandler, consume func(context.Context) error) (*UpdateRuntime, error) {
	if account <= 0 || storage == nil || record == nil || consume == nil {
		return nil, errors.New("update runtime requires account, durable storage, recorder and consumer")
	}
	return &UpdateRuntime{account: account, storage: storage, record: record, consume: consume, ready: make(chan struct{})}, nil
}

// Ready signals that gotd has installed its internal state, not that startup
// getDifference has finished. It never closes when startup fails before this.
func (r *UpdateRuntime) Ready() <-chan struct{} { return r.ready }

func (r *UpdateRuntime) Handle(ctx context.Context, u tg.UpdatesClass) error {
	r.mu.Lock()
	manager, runCtx, accepting := r.manager, r.ctx, r.accepting
	r.mu.Unlock()
	if !accepting {
		return ErrRuntimeNotReady
	}
	if err := runCtx.Err(); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(runCtx, cancel)
	defer stop()
	defer cancel()
	return manager.Handle(ctx, u)
}

// Run cancels both loops on failure and waits for both before returning. It
// cannot force an uncooperative recorder/consumer to exit. Database ownership
// remains with the caller, which must close it only after Run has returned.
func (r *UpdateRuntime) Run(ctx context.Context, api updates.API) error {
	if !r.started.CompareAndSwap(false, true) {
		return ErrRuntimeUsed
	}
	if api == nil {
		return errors.New("update API required")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	_, found, err := r.storage.GetState(ctx, r.account)
	if err != nil {
		return err
	}
	if !found {
		return ErrInitialStateRequired
	}
	f := NewFailureFence(ctx)
	defer f.Close()
	hashes := HashStorage{ChannelAccessHasher: r.storage, UserAccessHasher: r.storage, Fence: f}
	resync := func() { _ = f.Apply(context.Background(), func(context.Context) error { return ErrResyncRequired }) }
	manager := updates.New(updates.Config{
		Storage: CheckpointStorage{StateStorage: r.storage, Fence: f}, AccessHasher: hashes, UserAccessHasher: hashes,
		Handler: telegram.UpdateHandlerFunc(func(ctx context.Context, u tg.UpdatesClass) error {
			return f.Apply(ctx, func(ctx context.Context) error { return r.record.Handle(ctx, u) })
		}),
		OnLoadChannelStateFailed: func(int64) { resync() }, OnLoadUserStateFailed: resync,
		OnTooLong: resync, OnChannelTooLong: func(int64) { resync() },
	})
	group, runCtx := errgroup.WithContext(f.Context())
	r.mu.Lock()
	r.manager = manager
	r.ctx = runCtx
	r.mu.Unlock()
	defer func() { r.mu.Lock(); r.accepting = false; r.mu.Unlock() }()
	group.Go(func() error {
		err := manager.Run(runCtx, api, r.account, updates.AuthOptions{OnStart: func(context.Context) {
			r.mu.Lock()
			if runCtx.Err() == nil {
				r.accepting = true
				close(r.ready)
			}
			r.mu.Unlock()
		}})
		if err == nil && runCtx.Err() == nil {
			return errors.New("update manager ended unexpectedly")
		}
		return err
	})
	group.Go(func() error {
		select {
		case <-r.ready:
		case <-runCtx.Done():
			return runCtx.Err()
		}
		if err := runCtx.Err(); err != nil {
			return err
		}
		err := r.consume(runCtx)
		if err == nil && runCtx.Err() == nil {
			return errors.New("update consumer ended unexpectedly")
		}
		return err
	})
	err = group.Wait()
	return errors.Join(err, f.Err())
}
