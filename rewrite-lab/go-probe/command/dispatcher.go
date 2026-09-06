package command

import (
	"context"
	"maps"
	"slices"
	"strings"
)

// Envelope carries normalized routing fields alongside transport-owned data.
// Handlers must treat Native as read-only; alias expansion changes Text only.
type Envelope struct {
	Message
	Out, Saved, Edited bool
	Native             any
}

type Invocation struct {
	Command string
	Message Envelope
	Trigger *Envelope
}

type Entry struct {
	Original, AliasFinal string
	IgnoreEdited         bool
	Handler              func(context.Context, Invocation) error
}

// Dispatcher is an immutable routing snapshot for one runtime generation.
type Dispatcher struct {
	prefixes []string
	aliases  map[string]bool
	entries  map[string]Entry
}

func NewDispatcher(prefixes []string, aliases map[string]bool, entries map[string]Entry) *Dispatcher {
	return &Dispatcher{prefixes: slices.Clone(prefixes), aliases: maps.Clone(aliases), entries: maps.Clone(entries)}
}

func (d *Dispatcher) Primary(ctx context.Context, msg Envelope) (bool, error) {
	if !msg.Out && !msg.Saved {
		return false, nil
	}
	cmd := Parse(msg.Text, d.prefixes, d.aliases)
	if cmd == "" {
		return false, nil
	}
	return d.Dispatch(ctx, cmd, msg, nil, msg.Edited)
}

// Dispatch also serves delegated commands after their separate permission and
// send steps. A handler error is returned for the transport layer to report.
func (d *Dispatcher) Dispatch(ctx context.Context, cmd string, msg Envelope, trigger *Envelope, edited bool) (bool, error) {
	entry, exists := d.entries[cmd]
	if !exists || entry.Handler == nil || edited && entry.IgnoreEdited {
		return false, nil
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	target := cmd
	if entry.Original != "" {
		target = entry.Original
	}
	if entry.Original != "" && entry.AliasFinal != "" && entry.AliasFinal != entry.Original {
		prefix := ""
		for _, p := range d.prefixes {
			if strings.HasPrefix(msg.Text, p) {
				prefix = p
				break
			}
		}
		parts := strings.FieldsFunc(msg.Text[len(prefix):], jsSpace)
		alias := strings.FieldsFunc(cmd, jsSpace)
		if len(parts) >= len(alias) && slices.Equal(parts[:len(alias)], alias) {
			final := strings.FieldsFunc(entry.AliasFinal, jsSpace)
			msg.Text = prefix + strings.Join(append(final, parts[len(alias):]...), " ")
		}
	}
	return true, entry.Handler(ctx, Invocation{Command: target, Message: msg, Trigger: trigger})
}
