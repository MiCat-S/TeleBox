package inbox

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"time"
)

var ErrConsumerBusy = errors.New("inbox consumer already processing")

// Consumer serializes batches within one instance. The application must own
// exactly one consumer per database; this is not a cross-process lease.
type Consumer struct {
	store  *Store
	handle func(context.Context, Event) error
	busy   atomic.Bool
}

func NewConsumer(store *Store, handle func(context.Context, Event) error) (*Consumer, error) {
	if store == nil || handle == nil {
		return nil, errors.New("consumer store and handler required")
	}
	return &Consumer{store: store, handle: handle}, nil
}

// Process handles at most limit events in durable sequence order. Failure stops
// the batch, preserving the failed event and its successors for explicit retry.
// A side effect followed by a failed Complete can replay: handlers must use the
// event's Account/Key for business-specific idempotence where supported.
func (c *Consumer) Process(ctx context.Context, limit int) (completed int, err error) {
	if !c.busy.CompareAndSwap(false, true) {
		return 0, ErrConsumerBusy
	}
	defer c.busy.Store(false)
	return c.process(ctx, limit)
}

// Run owns this instance until cancellation or failure. It drains available
// batches immediately and polls only after an empty batch. Errors are returned
// to the application coordinator, not retried or skipped automatically.
func (c *Consumer) Run(ctx context.Context, limit int, idlePoll time.Duration) error {
	if limit < 1 || limit > 1000 || idlePoll <= 0 {
		return errors.New("consumer requires batch limit 1..1000 and positive idle poll")
	}
	if !c.busy.CompareAndSwap(false, true) {
		return ErrConsumerBusy
	}
	defer c.busy.Store(false)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, err := c.process(ctx, limit)
		if err != nil {
			return err
		}
		if n != 0 {
			continue
		}
		timer := time.NewTimer(idlePoll)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func (c *Consumer) process(ctx context.Context, limit int) (completed int, err error) {
	events, err := c.store.Pending(ctx, limit)
	if err != nil {
		return 0, err
	}
	for _, event := range events {
		if err := ctx.Err(); err != nil {
			return completed, err
		}
		if err := invoke(ctx, c.handle, event); err != nil {
			return completed, fmt.Errorf("handle inbox sequence %d: %w", event.Sequence, err)
		}
		if err := c.store.Complete(ctx, event.Sequence); err != nil {
			return completed, fmt.Errorf("complete inbox sequence %d: %w", event.Sequence, err)
		}
		completed++
	}
	return completed, nil
}

func invoke(ctx context.Context, handle func(context.Context, Event) error, event Event) (err error) {
	defer func() {
		if value := recover(); value != nil {
			err = fmt.Errorf("handler panic: %v", value)
		}
	}()
	return handle(ctx, event)
}
