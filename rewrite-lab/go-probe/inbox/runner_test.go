package inbox

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"telebox.local/rewrite-probe/lifecycle"
)

func TestConsumerRunWaitsForIngressAndStopsOnFailure(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "runner.sqlite"), 1024)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	failure := errors.New("business failure")
	entered := make(chan struct{})
	release := make(chan struct{})
	c, err := NewConsumer(s, func(ctx context.Context, _ Event) error {
		close(entered)
		select {
		case <-release:
			return failure
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- c.Run(ctx, 1, time.Millisecond) }()
	if _, err := s.Put(ctx, "101", "a", []byte("a")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("consumer did not observe ingress")
	}
	if _, err := c.Process(ctx, 1); !errors.Is(err, ErrConsumerBusy) {
		t.Error(err)
	}
	if err := c.Run(ctx, 1, time.Millisecond); !errors.Is(err, ErrConsumerBusy) {
		t.Error(err)
	}
	close(release)
	select {
	case err := <-done:
		if !errors.Is(err, failure) {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("failure not returned")
	}
	pending, err := s.Pending(ctx, 1)
	if err != nil || len(pending) != 1 {
		t.Fatalf("pending=%d err=%v", len(pending), err)
	}
	c.handle = func(context.Context, Event) error { return nil }
	if n, err := c.Process(ctx, 1); n != 1 || err != nil {
		t.Fatalf("completed=%d err=%v", n, err)
	}
}

func TestConsumerRunGenerationDrain(t *testing.T) {
	for _, active := range []bool{false, true} {
		name := "idle"
		if active {
			name = "active"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			s, err := Open(ctx, filepath.Join(t.TempDir(), "runner.sqlite"), 1024)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			entered := make(chan struct{})
			c, err := NewConsumer(s, func(ctx context.Context, _ Event) error { close(entered); <-ctx.Done(); return ctx.Err() })
			if err != nil {
				t.Fatal(err)
			}
			if active {
				if _, err := s.Put(ctx, "101", "a", []byte("a")); err != nil {
					t.Fatal(err)
				}
			}
			g := lifecycle.New(ctx)
			started := make(chan struct{})
			result, err := g.Run("inbox", func(ctx context.Context) error { close(started); return c.Run(ctx, 10, time.Hour) })
			if err != nil {
				t.Fatal(err)
			}
			<-started
			if active {
				select {
				case <-entered:
				case <-ctx.Done():
					t.Fatal("handler not started")
				}
			}
			report, err := g.Drain(ctx)
			if err != nil || !report.Completed {
				t.Fatalf("drain=%+v err=%v", report, err)
			}
			if err := <-result; !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
			pending, err := s.Pending(ctx, 10)
			want := 0
			if active {
				want = 1
			}
			if err != nil || len(pending) != want {
				t.Fatalf("pending=%d want=%d err=%v", len(pending), want, err)
			}
		})
	}
}

func TestConsumerRunRejectsInvalidOptions(t *testing.T) {
	c := &Consumer{}
	for _, limit := range []int{0, 1001} {
		if err := c.Run(context.Background(), limit, time.Second); err == nil {
			t.Fatal("invalid limit accepted")
		}
	}
	if err := c.Run(context.Background(), 1, 0); err == nil {
		t.Fatal("invalid interval accepted")
	}
}
