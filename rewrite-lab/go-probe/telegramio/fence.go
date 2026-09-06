package telegramio

import (
	"context"
	"fmt"
	"sync"

	"github.com/gotd/td/telegram/updates"
)

// FailureFence belongs to one update-manager lifetime. It serializes durable
// ingress, peer hash and checkpoint writes and closes on the first failure.
// Recovery requires a new fence and Manager, not resetting this latch.
type FailureFence struct {
	mu     sync.Mutex
	ctx    context.Context
	cancel context.CancelFunc
	err    error
}

func NewFailureFence(parent context.Context) *FailureFence {
	ctx, cancel := context.WithCancel(parent)
	return &FailureFence{ctx: ctx, cancel: cancel}
}

func (f *FailureFence) Context() context.Context { return f.ctx }
func (f *FailureFence) Close()                   { f.cancel() }
func (f *FailureFence) Err() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.err
}

// Apply must wrap durable ingress, peer hashes and every checkpoint mutation.
// The callback must not recursively call this fence.
func (f *FailureFence) Apply(ctx context.Context, fn func(context.Context) error) (err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	defer func() {
		if value := recover(); value != nil {
			f.err = fmt.Errorf("durable operation panic: %v", value)
			f.cancel()
			err = f.err
		}
	}()
	if f.err != nil {
		return f.err
	}
	if err := f.ctx.Err(); err != nil {
		f.err = err
	} else if err := ctx.Err(); err != nil {
		f.err = err
	} else {
		f.err = fn(ctx)
	}
	if f.err != nil {
		f.cancel()
	}
	return f.err
}

// CheckpointStorage forwards reads but fences all writes. It must share the
// handler's fence; wrapping storage alone cannot protect a failed ingress.
type CheckpointStorage struct {
	updates.StateStorage
	Fence *FailureFence
}

func (s CheckpointStorage) SetState(ctx context.Context, uid int64, state updates.State) error {
	return s.Fence.Apply(ctx, func(ctx context.Context) error { return s.StateStorage.SetState(ctx, uid, state) })
}
func (s CheckpointStorage) SetPts(ctx context.Context, uid int64, value int) error {
	return s.Fence.Apply(ctx, func(ctx context.Context) error { return s.StateStorage.SetPts(ctx, uid, value) })
}
func (s CheckpointStorage) SetQts(ctx context.Context, uid int64, value int) error {
	return s.Fence.Apply(ctx, func(ctx context.Context) error { return s.StateStorage.SetQts(ctx, uid, value) })
}
func (s CheckpointStorage) SetDate(ctx context.Context, uid int64, value int) error {
	return s.Fence.Apply(ctx, func(ctx context.Context) error { return s.StateStorage.SetDate(ctx, uid, value) })
}
func (s CheckpointStorage) SetSeq(ctx context.Context, uid int64, value int) error {
	return s.Fence.Apply(ctx, func(ctx context.Context) error { return s.StateStorage.SetSeq(ctx, uid, value) })
}
func (s CheckpointStorage) SetDateSeq(ctx context.Context, uid int64, date, seq int) error {
	return s.Fence.Apply(ctx, func(ctx context.Context) error { return s.StateStorage.SetDateSeq(ctx, uid, date, seq) })
}
func (s CheckpointStorage) SetChannelPts(ctx context.Context, uid, channel int64, value int) error {
	return s.Fence.Apply(ctx, func(ctx context.Context) error { return s.StateStorage.SetChannelPts(ctx, uid, channel, value) })
}

var _ updates.StateStorage = CheckpointStorage{}

// HashStorage must share the handler/checkpoint fence because gotd's feeders
// log storage failures without returning them to update dispatch.
type HashStorage struct {
	updates.ChannelAccessHasher
	updates.UserAccessHasher
	Fence *FailureFence
}

func (s HashStorage) SetUserAccessHash(ctx context.Context, account, target, hash int64) error {
	return s.Fence.Apply(ctx, func(ctx context.Context) error {
		return s.UserAccessHasher.SetUserAccessHash(ctx, account, target, hash)
	})
}

func (s HashStorage) SetChannelAccessHash(ctx context.Context, account, target, hash int64) error {
	return s.Fence.Apply(ctx, func(ctx context.Context) error {
		return s.ChannelAccessHasher.SetChannelAccessHash(ctx, account, target, hash)
	})
}

var _ updates.UserAccessHasher = HashStorage{}
var _ updates.ChannelAccessHasher = HashStorage{}
