package gt

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"reflect"
	"testing"

	"telebox.local/rewrite-probe/command"
)

type recording struct {
	reply          string
	edits, replies []string
}

func (m *recording) ReplyText(context.Context) (string, error) { return m.reply, nil }
func (m *recording) EditHTML(_ context.Context, s string) error {
	m.edits = append(m.edits, s)
	return nil
}
func (m *recording) ReplyHTML(_ context.Context, s string) error {
	m.replies = append(m.replies, s)
	return nil
}

func TestActualBaselineFixtures(t *testing.T) {
	data, err := exec.Command("node", "../../../gt-fixtures.cjs").Output()
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name, Text, Reply string
		Output            *string
		Missing, Failure  bool
		Edits, Replies    []string
		Requests          [][]string
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			m := &recording{reply: c.Reply, edits: []string{}, replies: []string{}}
			requests := [][]string{}
			var p Provider
			if !c.Missing {
				p = func(_ context.Context, text, target string) (string, error) {
					requests = append(requests, []string{text, target})
					if c.Failure {
						return "", errors.New("secret-api-key")
					}
					if c.Output != nil {
						return *c.Output, nil
					}
					return "ok", nil
				}
			}
			if err := Handle(context.Background(), c.Text, m, p); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(requests, c.Requests) || !reflect.DeepEqual(m.edits, c.Edits) || !reflect.DeepEqual(m.replies, c.Replies) {
				t.Fatalf("baseline differs for %s: requests=%v edits=%v replies=%v", c.Name, requests, m.edits, m.replies)
			}
		})
	}
}

func TestCancellationSuppressesLateProviderResult(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := &recording{}
	err := Handle(ctx, ".gt hello", m, func(context.Context, string, string) (string, error) { cancel(); return "late", nil })
	if !errors.Is(err, context.Canceled) || len(m.edits) != 1 || len(m.replies) != 0 {
		t.Fatalf("err=%v edits=%v", err, m.edits)
	}
	m = &recording{}
	err = Handle(ctx, ".gt hello", m, func(context.Context, string, string) (string, error) {
		t.Error("provider called after cancellation")
		return "", nil
	})
	if !errors.Is(err, context.Canceled) || len(m.edits) != 0 {
		t.Fatal(err, m.edits)
	}
}

func TestTranslationThroughAliasDispatcher(t *testing.T) {
	m := &recording{}
	var source, target string
	p := func(_ context.Context, text, language string) (string, error) {
		source, target = text, language
		return "hello", nil
	}
	d := command.NewDispatcher([]string{"."}, map[string]bool{"translate": true}, map[string]command.Entry{
		"translate": {
			Original: "gt", AliasFinal: "gt en",
			Handler: func(ctx context.Context, invocation command.Invocation) error {
				return Handle(ctx, invocation.Message.Text, m, p)
			},
		},
	})
	e := command.Envelope{Message: command.Message{Text: ".translate 你好"}, Out: true}
	called, err := d.Primary(context.Background(), e)
	if err != nil || !called || source != "你好" || target != "en" {
		t.Fatalf("called=%v source=%q target=%q err=%v", called, source, target, err)
	}
	if e.Text != ".translate 你好" {
		t.Fatal("source envelope mutated")
	}
	e.Out = false
	before := len(m.edits)
	if called, err := d.Primary(context.Background(), e); called || err != nil || len(m.edits) != before {
		t.Fatal("incoming message entered primary translation handler")
	}
}
