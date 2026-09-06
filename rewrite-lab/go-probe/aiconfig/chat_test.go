package aiconfig

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"telebox.local/rewrite-probe/plugins/gt"
)

type message struct{ edits []string }

func (m *message) ReplyText(context.Context) (string, error) { return "", nil }
func (m *message) EditHTML(_ context.Context, s string) error {
	m.edits = append(m.edits, s)
	return nil
}
func (m *message) ReplyHTML(context.Context, string) error { return nil }

func configFor(t *testing.T, endpoint, kind string, responses bool, timeout float64) *Document {
	t.Helper()
	data, err := json.Marshal(map[string]any{"configs": map[string]any{"test": map[string]any{"type": kind, "url": endpoint, "key": "synthetic", "responses": responses}}, "currentChatTag": "test", "currentChatModel": "fixture-model", "timeout": timeout, "currentChatReasoningEffort": " LOW ", "currentChatServiceTier": "unknown"})
	if err != nil {
		t.Fatal(err)
	}
	d, err := Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestLegacyConfigToGTLocalRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer synthetic" || r.Header.Get("User-Agent") != legacyUserAgent {
			t.Error("legacy request mapping differs")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["model"] != "fixture-model" || body["reasoning_effort"] != "low" {
			t.Error("model or reasoning differs")
		}
		if _, ok := body["service_tier"]; ok {
			t.Error("invalid tier not normalized to auto")
		}
		w.Write([]byte(`{"choices":[{"message":{"content":"你好"}}]}`))
	}))
	defer server.Close()
	d := configFor(t, server.URL+"/v1", "openai-compatible", false, 1)
	original := string(d.Bytes())
	chat, err := d.BuildChat(server.Client().Transport, 4096)
	if err != nil {
		t.Fatal(err)
	}
	m := &message{}
	if err := gt.Handle(context.Background(), ".gt hello", m, chat.Translate); err != nil {
		t.Fatal(err)
	}
	if len(m.edits) != 2 || !strings.HasSuffix(m.edits[1], "你好") {
		t.Fatal(m.edits)
	}
	if string(d.Bytes()) != original {
		t.Fatal("runtime construction changed config")
	}
}

func TestLegacyTimeoutAndUnsupportedProfiles(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	d := configFor(t, server.URL, "openai", false, 0.03)
	chat, err := d.BuildChat(server.Client().Transport, 4096)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := chat.Chat(context.Background(), "hello"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	for _, kind := range []string{"gemini"} {
		if _, err := configFor(t, server.URL, kind, false, 1).BuildChat(server.Client().Transport, 4096); err == nil {
			t.Fatal("unsupported profile silently remapped")
		}
	}
	if _, err := configFor(t, server.URL, "openai", true, 1).BuildChat(server.Client().Transport, 4096); err == nil {
		t.Fatal("Responses silently remapped")
	}
	if _, err := configFor(t, server.URL, "openai", false, -1).BuildChat(server.Client().Transport, 4096); err == nil {
		t.Fatal("invalid timeout accepted")
	}
}
