package probe

import (
	"context"
	"errors"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/dcs"
	"github.com/gotd/td/tg"

	"telebox.local/rewrite-probe/lifecycle"
)

func TestClientInsideGenerationDrain(t *testing.T) {
	var active atomic.Int32
	for generation := 0; generation < 10; generation++ {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		g := lifecycle.New(ctx)
		started := make(chan struct{}, 1)
		client := telegram.NewClient(1, "synthetic", telegram.Options{
			Resolver: dcs.Plain(dcs.PlainOptions{
				Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
					active.Add(1)
					defer active.Add(-1)
					select {
					case started <- struct{}{}:
					default:
					}
					<-ctx.Done()
					return nil, ctx.Err()
				},
			}),
			DCList: dcs.List{Options: []tg.DCOption{{ID: 2, IPAddress: "127.0.0.1", Port: 1}}},
		})
		result, err := g.Run("telegram-client", func(taskCtx context.Context) error {
			return client.Run(taskCtx, func(context.Context) error {
				return errors.New("unexpected successful connection")
			})
		})
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		select {
		case <-started:
		case <-ctx.Done():
			cancel()
			t.Fatal("tracked client did not start dialing")
		}
		report, err := g.Drain(ctx)
		cancel()
		if err != nil || !report.Completed || report.PendingTasks != 0 || report.PendingResources != 0 || len(report.TaskErrors) != 0 || active.Load() != 0 {
			t.Fatalf("generation %d failed to drain client: %+v %v, active=%d", generation, report, err, active.Load())
		}
		if err := <-result; err != nil && !errors.Is(err, context.Canceled) {
			t.Fatalf("unexpected client exit: %v", err)
		}
	}
}

func TestCancelPendingClientAndReplaceGeneration(t *testing.T) {
	for generation := 0; generation < 10; generation++ {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		started := make(chan struct{}, 1)
		var active atomic.Int32
		var ready atomic.Bool
		resolver := dcs.Plain(dcs.PlainOptions{
			Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
				active.Add(1)
				defer active.Add(-1)
				select {
				case started <- struct{}{}:
				default:
				}
				<-ctx.Done()
				return nil, ctx.Err()
			},
		})
		client := telegram.NewClient(1, "synthetic", telegram.Options{
			Resolver: resolver,
			DCList:   dcs.List{Options: []tg.DCOption{{ID: 2, IPAddress: "127.0.0.1", Port: 1}}},
		})
		done := make(chan error, 1)
		go func() {
			done <- client.Run(ctx, func(context.Context) error {
				ready.Store(true)
				return errors.New("unexpected successful connection")
			})
		}()
		select {
		case <-started:
		case err := <-done:
			cancel()
			t.Fatalf("generation %d exited before dialing: %v", generation, err)
		case <-ctx.Done():
			cancel()
			t.Fatal("dial did not start")
		}
		cancel()
		select {
		case err := <-done:
			if err != nil && !errors.Is(err, context.Canceled) {
				t.Fatalf("unexpected shutdown result: %v", err)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("client did not stop after cancellation")
		}
		if active.Load() != 0 || ready.Load() {
			t.Fatal("pending dial leaked or ready callback fired")
		}
		// A completed client is not reused by a new generation.
		reuseCtx, stopReuse := context.WithTimeout(context.Background(), time.Second)
		err := client.Run(reuseCtx, func(context.Context) error { return nil })
		stopReuse()
		if err == nil || !strings.Contains(err.Error(), "client already closed") {
			t.Fatal("closed client unexpectedly reusable")
		}
	}
}
