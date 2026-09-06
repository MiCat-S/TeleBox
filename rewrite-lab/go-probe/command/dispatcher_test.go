package command

import (
	"context"
	"errors"
	"testing"
	"time"

	"telebox.local/rewrite-probe/lifecycle"
)

func TestPrimaryIdentityAndEditedPolicy(t *testing.T) {
	for _, ignore := range []bool{false, true} {
		for _, flags := range [][3]bool{{false, false, false}, {true, false, false}, {false, true, false}, {false, false, true}, {true, false, true}, {false, true, true}} {
			calls := 0
			d := NewDispatcher([]string{"."}, nil, map[string]Entry{"ping": {IgnoreEdited: ignore, Handler: func(_ context.Context, in Invocation) error {
				calls++
				if in.Command != "ping" {
					t.Error("wrong command")
				}
				return nil
			}}})
			msg := Envelope{Message: Message{Text: ".ping"}, Out: flags[0], Saved: flags[1], Edited: flags[2]}
			called, err := d.Primary(context.Background(), msg)
			want := (msg.Out || msg.Saved) && !(msg.Edited && ignore)
			if err != nil || called != want || (calls == 1) != want {
				t.Fatalf("flags=%v ignore=%v called=%v calls=%d err=%v", flags, ignore, called, calls, err)
			}
		}
	}
}

func TestDispatchThroughGenerationExecutor(t *testing.T) {
	g := lifecycle.New(context.Background())
	e, err := lifecycle.NewExecutor(g, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	d := NewDispatcher([]string{"."}, nil, map[string]Entry{"ping": {Handler: func(ctx context.Context, _ Invocation) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	}}})
	result, err := e.Submit(func(ctx context.Context) error {
		_, err := d.Primary(ctx, Envelope{Message: Message{Text: ".ping"}, Out: true})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("handler not started")
	}
	report, err := g.Drain(ctx)
	if err != nil || !report.Completed {
		t.Fatalf("command drain: %+v %v", report, err)
	}
	if !errors.Is(<-result, context.Canceled) {
		t.Fatal("handler did not receive generation cancellation")
	}
}

func TestAliasExpansionPreservesSourceAndMetadata(t *testing.T) {
	native := &struct{ ID int }{42}
	msg := Envelope{Message: Message{Text: ".test link extra", UserID: "101", ChatID: "202", Topic: 77, Reply: 88}, Out: true, Native: native}
	trigger := &Envelope{Message: Message{Text: "original trigger"}}
	var got Invocation
	d := NewDispatcher([]string{"."}, map[string]bool{"test link": true}, map[string]Entry{
		"test link": {Original: "ping", AliasFinal: "ping dc1", Handler: func(_ context.Context, in Invocation) error { got = in; return nil }},
	})
	called, err := d.Dispatch(context.Background(), "test link", msg, trigger, false)
	if err != nil || !called || got.Command != "ping" || got.Message.Text != ".ping dc1 extra" || got.Trigger != trigger {
		t.Fatalf("bad invocation: %+v %v", got, err)
	}
	if msg.Text != ".test link extra" || got.Message.Native != native || got.Message.Topic != 77 || got.Message.Reply != 88 || got.Message.UserID != "101" {
		t.Fatal("source or metadata changed")
	}
}

func TestDispatcherSnapshotIsIndependent(t *testing.T) {
	prefixes := []string{"."}
	aliases := map[string]bool{"go now": true}
	calls := 0
	entries := map[string]Entry{"go now": {Original: "ping", Handler: func(context.Context, Invocation) error { calls++; return nil }}}
	d := NewDispatcher(prefixes, aliases, entries)
	prefixes[0] = "!"
	delete(aliases, "go now")
	delete(entries, "go now")
	called, err := d.Primary(context.Background(), Envelope{Message: Message{Text: ".go now"}, Out: true})
	if err != nil || !called || calls != 1 {
		t.Fatal("routing snapshot mutated")
	}
}

func TestDispatcherErrorsAndUnknownCommand(t *testing.T) {
	failure := errors.New("handler failed")
	d := NewDispatcher([]string{"."}, nil, map[string]Entry{"ping": {Handler: func(context.Context, Invocation) error { return failure }}})
	msg := Envelope{Message: Message{Text: ".ping"}, Out: true}
	if called, err := d.Primary(context.Background(), msg); !called || !errors.Is(err, failure) {
		t.Fatal("handler failure hidden")
	}
	if called, err := d.Dispatch(context.Background(), "missing", msg, nil, false); called || err != nil {
		t.Fatal("unknown command dispatched")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if called, err := d.Primary(ctx, msg); called || !errors.Is(err, context.Canceled) {
		t.Fatal("canceled command ran")
	}
}
