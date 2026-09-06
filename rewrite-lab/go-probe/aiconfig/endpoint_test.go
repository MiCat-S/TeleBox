package aiconfig

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"testing"
)

func TestChatEndpointsAgainstActualBaseline(t *testing.T) {
	data, err := exec.Command("node", "../../chat-endpoint-fixtures.cjs").Output()
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct{ Profile, URL, Key, Endpoint, Authorization string }
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) != 9 {
		t.Fatal("endpoint fixture coverage changed")
	}
	for _, c := range cases {
		endpoint, headers, err := chatEndpoint(c.URL, c.Profile, c.Key)
		if err != nil || endpoint != c.Endpoint || headers.Get("Authorization") != c.Authorization {
			t.Fatalf("profile=%s got=%s want=%s err=%v", c.Profile, endpoint, c.Endpoint, err)
		}
	}
}

func TestAdditionalProfilesSendLocalChatRequests(t *testing.T) {
	for _, profile := range []string{"moonshot", "doubao", "local-cliproxy"} {
		t.Run(profile, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				want := "/v1/chat/completions"
				if profile == "doubao" {
					want = "/api/v3/chat/completions"
				}
				if r.URL.Path != want {
					t.Errorf("path=%s want=%s", r.URL.Path, want)
				}
				if profile == "local-cliproxy" {
					if r.URL.Query().Get("key") != "synthetic" || r.Header.Get("Authorization") != "" {
						t.Error("query auth differs")
					}
				} else if r.Header.Get("Authorization") != "Bearer synthetic" {
					t.Error("bearer auth differs")
				}
				w.Write([]byte(`{"choices":[{"message":{"content":"hello"}}]}`))
			}))
			defer server.Close()
			d := configFor(t, server.URL+"/v1", profile, false, 1)
			chat, err := d.BuildChat(server.Client().Transport, 4096)
			if err != nil {
				t.Fatal(err)
			}
			if text, err := chat.Translate(context.Background(), "你好", "en"); err != nil || text != "hello" {
				t.Fatalf("text=%s err=%v", text, err)
			}
		})
	}
}
