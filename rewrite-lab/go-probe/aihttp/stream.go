package aihttp

import (
	"encoding/json"
	"errors"
	"strings"
)

// parseChatStream collects text only. Unknown metadata events are allowed, but
// malformed payloads and missing completion are errors, not successful partial
// translations. HTTP buffering/byte bounds are owned by Client.
func parseChatStream(raw []byte) (string, error) {
	var output strings.Builder
	var data []string
	done := false
	dispatch := func() error {
		if len(data) == 0 {
			return nil
		}
		body := strings.Join(data, "\n")
		data = nil
		if done {
			return errors.New("chat stream data after completion")
		}
		if body == "[DONE]" {
			done = true
			return nil
		}
		var payload struct {
			Error   json.RawMessage `json:"error"`
			Choices []struct {
				Delta struct {
					Content json.RawMessage `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(body), &payload); err != nil {
			return errors.New("invalid chat stream JSON")
		}
		if len(payload.Error) > 0 && string(payload.Error) != "null" {
			return errors.New("chat stream provider error")
		}
		if len(payload.Choices) > 0 && payload.Choices[0].Delta.Content != nil {
			text, err := contentText(payload.Choices[0].Delta.Content)
			if err != nil {
				return err
			}
			output.WriteString(text)
		}
		return nil
	}
	// SSE permits CR, LF and CRLF line endings; remove a leading UTF-8 BOM.
	text := strings.TrimPrefix(string(raw), "\ufeff")
	text = strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")
	for _, line := range strings.Split(text, "\n") {
		if line == "" {
			if err := dispatch(); err != nil {
				return "", err
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, found := strings.Cut(line, ":")
		if !found {
			value = ""
		}
		value = strings.TrimPrefix(value, " ")
		if field == "data" {
			data = append(data, value)
		}
	}
	if len(data) > 0 {
		return "", errors.New("unterminated chat stream event")
	}
	if !done {
		return "", errors.New("chat stream missing completion")
	}
	result := trimJS(output.String())
	if result == "" {
		return "", errors.New("chat stream has no text")
	}
	return result, nil
}
