package aiconfig

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

const fixture = `{
 "configs":{"local":{"tag":"local","url":"http://example.invalid/v1","key":"synthetic","stream":true,"responses":false,"future":{"id":9007199254740993}}},
 "currentChatTag":"local","currentChatModel":"fixture-model","currentChatReasoningEffort":"low","currentChatServiceTier":"auto",
 "prompt":"personal prompt","timeout":120,"currentImageModel":"image-fixture",
 "telegraph":{"list":[{"url":"https://example.invalid/page","createdAt":"synthetic"}]},
 "future":{"large":9007199254740993,"decimal":1.234567890123456789,"nothing":null}
}`

func TestLegacySelectionAndByteExactRoundTrip(t *testing.T) {
	input := []byte(fixture)
	d, err := Parse(input)
	if err != nil {
		t.Fatal(err)
	}
	input[0] = 'x'
	if string(d.Bytes()) != fixture {
		t.Fatal("source bytes mutated")
	}
	selected, err := d.Chat()
	if err != nil {
		t.Fatal(err)
	}
	if selected.Tag != "local" || selected.Model != "fixture-model" || selected.Prompt != "personal prompt" || selected.ReasoningEffort != "low" || selected.ServiceTier != "auto" || string(selected.Timeout) != "120" {
		t.Fatal("selection differs")
	}
	selected.Provider[0] = 'x'
	selected, err = d.Chat()
	if err != nil || selected.Provider[0] != '{' {
		t.Fatal("provider snapshot mutated")
	}
}

func TestModelUpdateAndReversePreserveOtherFields(t *testing.T) {
	d, err := Parse([]byte(fixture))
	if err != nil {
		t.Fatal(err)
	}
	changed, err := d.WithChatModel("new-fixture")
	if err != nil {
		t.Fatal(err)
	}
	if got, err := changed.Chat(); err != nil || got.Model != "new-fixture" {
		t.Fatal("model not changed")
	}
	restored, err := changed.WithChatModel("fixture-model")
	if err != nil {
		t.Fatal(err)
	}
	var before, after map[string]json.RawMessage
	json.Unmarshal(d.Bytes(), &before)
	json.Unmarshal(restored.Bytes(), &after)
	if len(before) != len(after) {
		t.Fatal("fields lost")
	}
	for key, value := range before {
		var compact bytes.Buffer
		if err := json.Compact(&compact, value); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(compact.Bytes(), after[key]) {
			t.Fatalf("field changed: %s", key)
		}
	}
	if !bytes.Contains(changed.Bytes(), []byte("9007199254740993")) || !bytes.Contains(changed.Bytes(), []byte("1.234567890123456789")) {
		t.Fatal("numeric precision lost")
	}
	if string(d.Bytes()) != fixture {
		t.Fatal("original document changed")
	}
}

func TestInvalidConfigIsNotSilentlyReplaced(t *testing.T) {
	for _, raw := range []string{`null`, `[]`, `{"key":"secret",`, `{"currentChatModel":"a","currentChatModel":"b"}`} {
		if _, err := Parse([]byte(raw)); err == nil || strings.Contains(err.Error(), "secret") {
			t.Fatal("invalid config accepted or leaked")
		}
	}
	for _, raw := range []string{`{}`, `{"currentChatTag":123}`, `{"currentChatTag":"missing","currentChatModel":"x","configs":{}}`} {
		d, err := Parse([]byte(raw))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := d.Chat(); err == nil {
			t.Fatal("invalid selection accepted")
		}
		if string(d.Bytes()) != raw {
			t.Fatal("invalid selection rewrote document")
		}
	}
}
