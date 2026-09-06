package aihttp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestLocalJSONRequestAndHeaders(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.Header.Get("Authorization") != "Bearer synthetic" || r.Header.Get("Content-Type") != "application/json" {
			t.Error("request headers differ")
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["text"] != "你好" {
			t.Error("request body differs", err)
		}
		w.Write([]byte(`{"text":"hello"}`))
	}))
	defer server.Close()
	c, err := New(server.Client().Transport, time.Second, 1024)
	if err != nil {
		t.Fatal(err)
	}
	headers := http.Header{"Authorization": {"Bearer synthetic"}}
	body, err := c.PostJSON(context.Background(), server.URL, headers, map[string]string{"text": "你好"})
	if err != nil || string(body) != `{"text":"hello"}` {
		t.Fatalf("body=%s err=%v", body, err)
	}
	if headers.Get("Content-Type") != "" {
		t.Fatal("caller headers mutated")
	}
}

func TestResponseLimitStatusAndRedirect(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/limit":
			w.Write([]byte(strings.Repeat("x", 17)))
		case "/status":
			http.Error(w, "secret-provider-details", 429)
		case "/redirect":
			http.Redirect(w, r, "/target", 307)
		case "/target":
			t.Error("redirect followed")
		}
	}))
	defer server.Close()
	c, err := New(server.Client().Transport, time.Second, 16)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.PostJSON(context.Background(), server.URL+"/limit", nil, nil); !errors.Is(err, ErrResponseLimit) {
		t.Fatal(err)
	}
	for path, code := range map[string]int{"/status": 429, "/redirect": 307} {
		_, err := c.PostJSON(context.Background(), server.URL+path, nil, nil)
		var status *StatusError
		if !errors.As(err, &status) || status.Code != code || strings.Contains(err.Error(), "secret") {
			t.Fatal(err)
		}
	}
}

func TestDeadlineWhileReadingBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	c, err := New(server.Client().Transport, 30*time.Millisecond, 1024)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.PostJSON(context.Background(), server.URL, nil, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
}

func TestParentCancellationWhileRequestActive(t *testing.T) {
	entered := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	c, err := New(server.Client().Transport, time.Second, 1024)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := c.PostJSON(ctx, server.URL, nil, nil); done <- err }()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("request did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("request did not cancel")
	}
}
