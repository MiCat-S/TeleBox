package inbox

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"testing"
)

func TestConsumerFailureAndReopen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "consumer.sqlite")
	s, err := Open(ctx, path, 1024)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	for _, key := range []string{"a", "b", "c"} {
		if _, err := s.Put(ctx, "101", key, []byte(key)); err != nil {
			t.Fatal(err)
		}
	}
	failure := errors.New("business failure")
	var seen []string
	c, err := NewConsumer(s, func(_ context.Context, e Event) error {
		seen = append(seen, e.Key)
		if e.Key == "b" {
			return failure
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if n, err := c.Process(ctx, 10); n != 1 || !errors.Is(err, failure) {
		t.Fatalf("completed=%d err=%v", n, err)
	}
	if !reflect.DeepEqual(seen, []string{"a", "b"}) {
		t.Fatal(seen)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(ctx, path, 1024)
	if err != nil {
		t.Fatal(err)
	}
	c, err = NewConsumer(s, func(_ context.Context, e Event) error { seen = append(seen, e.Key); return nil })
	if err != nil {
		t.Fatal(err)
	}
	if n, err := c.Process(ctx, 1); n != 1 || err != nil {
		t.Fatalf("completed=%d err=%v", n, err)
	}
	if n, err := c.Process(ctx, 10); n != 1 || err != nil {
		t.Fatalf("completed=%d err=%v", n, err)
	}
	if !reflect.DeepEqual(seen, []string{"a", "b", "b", "c"}) {
		t.Fatal(seen)
	}
	if n, err := c.Process(ctx, 10); n != 0 || err != nil {
		t.Fatalf("completed=%d err=%v", n, err)
	}
}

func TestConsumerOverlapPanicAndCanceledAcknowledgment(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "consumer.sqlite"), 1024)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.Put(ctx, "101", "a", []byte("a")); err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	c, err := NewConsumer(s, func(context.Context, Event) error { close(entered); <-release; panic("fixture") })
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := c.Process(ctx, 10); done <- err }()
	<-entered
	_, overlap := c.Process(ctx, 10)
	close(release)
	if err := <-done; err == nil {
		t.Fatal("panic not surfaced")
	}
	if !errors.Is(overlap, ErrConsumerBusy) {
		t.Fatal(overlap)
	}
	canceled, cancel := context.WithCancel(ctx)
	defer cancel()
	c.handle = func(context.Context, Event) error { cancel(); return nil }
	if n, err := c.Process(canceled, 10); n != 0 || !errors.Is(err, context.Canceled) {
		t.Fatalf("completed=%d err=%v", n, err)
	}
	pending, err := s.Pending(ctx, 10)
	if err != nil || len(pending) != 1 {
		t.Fatalf("pending=%d err=%v", len(pending), err)
	}
	c.handle = func(context.Context, Event) error { return nil }
	if n, err := c.Process(ctx, 10); n != 1 || err != nil {
		t.Fatalf("completed=%d err=%v", n, err)
	}
}
