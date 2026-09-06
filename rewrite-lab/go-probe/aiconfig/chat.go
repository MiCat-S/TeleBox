package aiconfig

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode"

	"telebox.local/rewrite-probe/aihttp"
)

// Matches the existing plugin's configured UA; not a claim about this runtime.
const legacyUserAgent = "codex-tui/0.146.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.146.0)"

// BuildChat maps legacy profiles whose chat strategy uses Chat Completions.
// Other protocols still require their own validated mapping.
func (d *Document) BuildChat(transport http.RoundTripper, maxBytes int64) (*aihttp.TextChat, error) {
	selection, err := d.Chat()
	if err != nil {
		return nil, err
	}
	var provider struct {
		URL       string `json:"url"`
		Key       string `json:"key"`
		Type      string `json:"type"`
		Stream    bool   `json:"stream"`
		Responses bool   `json:"responses"`
	}
	if json.Unmarshal(selection.Provider, &provider) != nil {
		return nil, errors.New("invalid AI provider fields")
	}
	profile := ProviderProfile(provider.URL, provider.Type)
	if provider.Responses {
		return nil, errors.New("Responses profile mapping not implemented")
	}
	endpoint, headers, err := chatEndpoint(provider.URL, profile, provider.Key)
	if err != nil {
		return nil, err
	}
	seconds := 30.0
	if len(selection.Timeout) > 0 {
		if string(selection.Timeout) == "null" || json.Unmarshal(selection.Timeout, &seconds) != nil || seconds <= 0 || seconds >= float64(1<<63-1)/float64(time.Second) {
			return nil, errors.New("invalid AI timeout")
		}
	}
	client, err := aihttp.New(transport, time.Duration(seconds*float64(time.Second)), maxBytes)
	if err != nil {
		return nil, err
	}
	return aihttp.NewTextChat(client, aihttp.ChatConfig{
		Endpoint: endpoint, Model: selection.Model, Prompt: selection.Prompt, Stream: provider.Stream,
		ReasoningEffort: normalized(selection.ReasoningEffort, []string{"auto", "none", "minimal", "low", "medium", "high", "xhigh"}),
		ServiceTier:     normalized(selection.ServiceTier, []string{"auto", "default", "priority", "fast", "flex"}),
		Headers:         headers,
	})
}

func normalized(value string, allowed []string) string {
	v := strings.ToLower(strings.TrimFunc(value, func(r rune) bool {
		return r == '\ufeff' || r == '\t' || r == '\n' || r == '\v' || r == '\f' || r == '\r' || r == '\u2028' || r == '\u2029' || unicode.Is(unicode.Zs, r)
	}))
	for _, candidate := range allowed {
		if v == candidate {
			return v
		}
	}
	return "auto"
}
