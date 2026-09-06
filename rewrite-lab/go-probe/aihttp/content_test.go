package aihttp

import (
	"encoding/json"
	"errors"
	"os/exec"
	"testing"
)

func TestTextContentAgainstActualBaseline(t *testing.T) {
	data, err := exec.Command("node", "../../chat-content-fixtures.cjs").Output()
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Content json.RawMessage
		Text    string
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) != 7 {
		t.Fatal("fixture coverage changed")
	}
	for _, c := range cases {
		text, err := contentText(c.Content)
		if err != nil || trimJS(text) != c.Text {
			t.Fatalf("content=%s text=%q baseline=%q err=%v", c.Content, text, c.Text, err)
		}
		stream := append([]byte("data: {\"choices\":[{\"delta\":{\"content\":"), c.Content...)
		stream = append(stream, []byte("}}]}\n\ndata: [DONE]\n\n")...)
		text, err = parseChatStream(stream)
		if err != nil || text != c.Text {
			t.Fatalf("stream text=%q baseline=%q err=%v", text, c.Text, err)
		}
	}
}

func TestTextAdapterDoesNotDiscardMedia(t *testing.T) {
	for _, raw := range []string{`[{"type":"text","text":"hi"},{"type":"image_url","image_url":{"url":"https://example.invalid/image"}}]`, `{"type":"unknown","text":"x"}`, `123`} {
		if text, err := contentText([]byte(raw)); !errors.Is(err, ErrUnsupportedContent) || text != "" {
			t.Fatalf("text=%q err=%v", text, err)
		}
	}
}
