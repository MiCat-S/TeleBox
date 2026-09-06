package aihttp

import (
	"encoding/json"
	"errors"
	"strings"
)

var ErrUnsupportedContent = errors.New("chat content requires another adapter")

// Text blocks follow the existing plugin's newline/trim behavior. Non-text
// blocks are explicit errors until their media adapter is connected.
func contentText(raw json.RawMessage) (string, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return "", nil
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text, nil
	}
	var parts []json.RawMessage
	if err := json.Unmarshal(raw, &parts); err != nil {
		parts = []json.RawMessage{raw}
	}
	var texts []string
	for _, part := range parts {
		var block struct {
			Type string  `json:"type"`
			Text *string `json:"text"`
		}
		if err := json.Unmarshal(part, &block); err != nil {
			return "", ErrUnsupportedContent
		}
		if (block.Type != "text" && block.Type != "output_text") || block.Text == nil {
			return "", ErrUnsupportedContent
		}
		texts = append(texts, *block.Text)
	}
	return trimJS(strings.Join(texts, "\n")), nil
}
