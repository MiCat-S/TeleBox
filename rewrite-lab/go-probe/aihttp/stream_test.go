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

func TestStreamEventFramingAndWhitespace(t *testing.T) {
	input := ": keepalive\nevent: message\ndata: {\ndata: \"choices\":[{\"delta\":{\"content\":\"Hello \"}}]}\n\n" +
		"data: {\"choices\":[{\"delta\":{\"content\":\"world😀\"}}]}\n\n" +
		"data: {\"choices\":[],\"usage\":{}}\n\ndata: [DONE]\n\n"
	for _, ending := range []string{"\n", "\r\n", "\r"} {
		text, err := parseChatStream([]byte("\ufeff" + strings.ReplaceAll(input, "\n", ending)))
		if err != nil || text != "Hello world😀" {
			t.Fatalf("text=%q err=%v", text, err)
		}
	}
}

func TestStreamRejectsPartialAndProviderErrors(t *testing.T) {
	for _, input := range []string{
		"data: {bad}\n\ndata: [DONE]\n\n",
		"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
		"data: [DONE]",
		"data: [DONE]\n\n",
		"data: {\"error\":{\"message\":\"secret\"}}\n\ndata: [DONE]\n\n",
		"data: [DONE]\n\ndata: {}\n\n",
	} {
		if text, err := parseChatStream([]byte(input)); err == nil || text != "" || strings.Contains(err.Error(), "secret") {
			t.Fatalf("text=%q err=%v", text, err)
		}
	}
}

func TestGTThroughFragmentedHTTPStream(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		if request["stream"] != true {
			t.Error("stream not requested")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		body := "data: {\"choices\":[{\"delta\":{\"content\":\"你好😀\"}}]}\n\ndata: [DONE]\n\n"
		for _, b := range []byte(body) {
			w.Write([]byte{b})
			w.(http.Flusher).Flush()
		}
	}))
	defer server.Close()
	c, err := New(server.Client().Transport, time.Second, 4096)
	if err != nil {
		t.Fatal(err)
	}
	chat, err := NewTextChat(c, ChatConfig{Endpoint: server.URL, Model: "fixture-model", Stream: true})
	if err != nil {
		t.Fatal(err)
	}
	m := &chatMessage{}
	if err := gt.Handle(context.Background(), ".gt hello", m, chat.Translate); err != nil {
		t.Fatal(err)
	}
	if len(m.edits) != 2 || !strings.HasSuffix(m.edits[1], "你好😀") {
		t.Fatal(m.edits)
	}
}
