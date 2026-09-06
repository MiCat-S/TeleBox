package aihttp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"telebox.local/rewrite-probe/plugins/gt"
)

type chatMessage struct{ edits []string }

func (m *chatMessage) ReplyText(context.Context) (string, error) { return "", nil }
func (m *chatMessage) EditHTML(_ context.Context, s string) error {
	m.edits = append(m.edits, s)
	return nil
}
func (m *chatMessage) ReplyHTML(context.Context, string) error { return nil }

func TestGTThroughLocalChatHTTP(t *testing.T) {
	requests := make(chan map[string]any, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if r.Header.Get("Authorization") != "Bearer synthetic" {
			t.Error("headers snapshot changed")
		}
		requests <- body
		w.Write([]byte(`{"choices":[{"message":{"content":"  <hello>  "}}]}`))
	}))
	defer server.Close()
	client, err := New(server.Client().Transport, time.Second, 4096)
	if err != nil {
		t.Fatal(err)
	}
	config := ChatConfig{Endpoint: server.URL, Model: "fixture-model", Prompt: "personal prompt", ReasoningEffort: "low", ServiceTier: "default", Headers: http.Header{"Authorization": {"Bearer synthetic"}}}
	chat, err := NewTextChat(client, config)
	if err != nil {
		t.Fatal(err)
	}
	config.Headers.Set("Authorization", "changed")
	m := &chatMessage{}
	if err := gt.Handle(context.Background(), ".gt en 你好", m, chat.Translate); err != nil {
		t.Fatal(err)
	}
	body := <-requests
	if body["model"] != "fixture-model" || body["reasoning_effort"] != "low" || body["service_tier"] != "default" || body["stream"] != false {
		t.Fatal(body)
	}
	messages := body["messages"].([]any)
	if messages[1].(map[string]any)["content"] != "你好" || !strings.Contains(messages[0].(map[string]any)["content"].(string), "翻译为英文") {
		t.Fatal(messages)
	}
	if len(m.edits) != 2 || !strings.HasSuffix(m.edits[1], "&lt;hello&gt;") {
		t.Fatal(m.edits)
	}
	if _, err := chat.Chat(context.Background(), "normal"); err != nil {
		t.Fatal(err)
	}
	body = <-requests
	if body["messages"].([]any)[0].(map[string]any)["content"] != "personal prompt" {
		t.Fatal("translation changed chat prompt")
	}
}

func TestChatRejectsUnsupportedResponsesAndOmitsAuto(t *testing.T) {
	for _, payload := range []string{`{`, `{"choices":[]}`, `{"choices":[{"message":{"content":null}}]}`, `{"choices":[{"message":{"content":[{"text":"x"}]}}]}`} {
		t.Run(payload, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if _, ok := body["reasoning_effort"]; ok {
					t.Error("auto reasoning sent")
				}
				if _, ok := body["service_tier"]; ok {
					t.Error("auto tier sent")
				}
				w.Write([]byte(payload))
			}))
			defer server.Close()
			client, err := New(server.Client().Transport, time.Second, 4096)
			if err != nil {
				t.Fatal(err)
			}
			config := ChatConfig{Endpoint: server.URL, Model: "fixture-model", ReasoningEffort: "auto", ServiceTier: "auto"}
			chat, err := NewTextChat(client, config)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := chat.Chat(context.Background(), "text"); err == nil {
				t.Fatal("invalid response accepted")
			}
		})
	}
}
