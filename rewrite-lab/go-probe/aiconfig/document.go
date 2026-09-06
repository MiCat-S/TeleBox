// Package aiconfig reads legacy AI configuration without starting providers.
package aiconfig

import (
	"bytes"
	"encoding/json"
	"errors"
)

type Document struct {
	original []byte
	fields   map[string]json.RawMessage
}
type ChatSelection struct {
	Tag, Model, Prompt, ReasoningEffort, ServiceTier string
	Provider                                         json.RawMessage
	Timeout                                          json.RawMessage
}

// Parse retains the source bytes and raw field values. Errors omit values,
// since provider keys and prompts may be present anywhere in the document.
func Parse(data []byte) (*Document, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields == nil {
		return nil, errors.New("AI config must be a JSON object")
	}
	// Duplicate top-level names cannot be updated losslessly by a map.
	decoder := json.NewDecoder(bytes.NewReader(data))
	if _, err := decoder.Token(); err != nil {
		return nil, errors.New("invalid AI config")
	}
	seen := map[string]bool{}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, errors.New("invalid AI config key")
		}
		key, ok := token.(string)
		if !ok || seen[key] {
			return nil, errors.New("duplicate or invalid AI config key")
		}
		seen[key] = true
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, errors.New("invalid AI config value")
		}
	}
	return &Document{original: bytes.Clone(data), fields: fields}, nil
}

// Bytes returns an independent, byte-exact copy until a documented edit occurs.
func (d *Document) Bytes() []byte { return bytes.Clone(d.original) }

func (d *Document) Chat() (ChatSelection, error) {
	var selection ChatSelection
	for key, target := range map[string]*string{"currentChatTag": &selection.Tag, "currentChatModel": &selection.Model, "prompt": &selection.Prompt, "currentChatReasoningEffort": &selection.ReasoningEffort, "currentChatServiceTier": &selection.ServiceTier} {
		raw, ok := d.fields[key]
		if !ok {
			continue
		}
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, target) != nil {
			return ChatSelection{}, errors.New("AI chat field must be a string")
		}
	}
	if selection.Tag == "" || selection.Model == "" {
		return ChatSelection{}, errors.New("AI chat selection is incomplete")
	}
	var providers map[string]json.RawMessage
	if json.Unmarshal(d.fields["configs"], &providers) != nil {
		return ChatSelection{}, errors.New("AI providers must be an object")
	}
	provider, ok := providers[selection.Tag]
	var shape map[string]json.RawMessage
	if !ok || json.Unmarshal(provider, &shape) != nil || shape == nil {
		return ChatSelection{}, errors.New("selected AI provider is missing or invalid")
	}
	selection.Provider = bytes.Clone(provider)
	selection.Timeout = bytes.Clone(d.fields["timeout"])
	return selection, nil
}

// WithChatModel creates a new legacy-format document. It changes no other
// field; no defaults, provider inference or runtime-specific schema are added.
func (d *Document) WithChatModel(model string) (*Document, error) {
	if model == "" {
		return nil, errors.New("chat model required")
	}
	fields := make(map[string]json.RawMessage, len(d.fields))
	for key, value := range d.fields {
		fields[key] = value
	}
	fields["currentChatModel"], _ = json.Marshal(model)
	data, err := json.Marshal(fields)
	if err != nil {
		return nil, errors.New("AI config encoding failed")
	}
	return Parse(data)
}
