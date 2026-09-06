// Package command implements candidate command decisions, not Telegram I/O.
package command

import (
	"slices"
	"strings"
	"unicode"
)

func jsSpace(r rune) bool {
	return unicode.Is(unicode.Zs, r) || strings.ContainsRune("\t\n\v\f\r\u2028\u2029\ufeff", r)
}

// Parse preserves the baseline's first prefix and longest alias behavior.
func Parse(text string, prefixes []string, aliases map[string]bool) string {
	matched := ""
	for _, prefix := range prefixes {
		if strings.HasPrefix(text, prefix) {
			matched = prefix
			break
		}
	}
	if matched == "" {
		return ""
	}
	parts := strings.FieldsFunc(text[len(matched):], jsSpace)
	for n := len(parts); n > 0; n-- {
		alias := strings.Join(parts[:n], " ")
		if aliases[alias] {
			return alias
		}
	}
	if len(parts) == 0 {
		return ""
	}
	for _, r := range parts[0] {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_') {
			return ""
		}
	}
	return parts[0]
}

type Message struct {
	UserID, ChatID, Text string
	Forwarded            bool
	Topic, Reply         int64
}

type Rule struct {
	Message  string `json:"msg"`
	Redirect string `json:"redirect"`
}

type Policy struct {
	Users, Chats           []string
	Prefixes, SudoPrefixes []string
	Aliases                map[string]bool
	Rules                  []Rule
}

type Decision struct {
	Send          bool
	Text, Command string
	ReplyTo       int64
	CopyEntities  bool
	DeleteDelayMS int
}

func (p Policy) allows(m Message) bool {
	return !m.Forwarded && m.UserID != "" && m.UserID != "0" && m.ChatID != "" && m.ChatID != "0" &&
		slices.Contains(p.Users, m.UserID) && (len(p.Chats) == 0 || slices.Contains(p.Chats, m.ChatID))
}

func reply(m Message) int64 {
	if m.Topic != 0 {
		return m.Topic
	}
	return m.Reply
}

// The baseline uses String.replace with a string pattern at offset zero.
func replacePrefix(prefix, suffix, replacement string) string {
	var b strings.Builder
	for i := 0; i < len(replacement); i++ {
		if replacement[i] == '$' && i+1 < len(replacement) {
			switch replacement[i+1] {
			case '$':
				b.WriteByte('$')
				i++
				continue
			case '&':
				b.WriteString(prefix)
				i++
				continue
			case '`':
				i++
				continue
			case '\'':
				b.WriteString(suffix)
				i++
				continue
			}
		}
		b.WriteByte(replacement[i])
	}
	b.WriteString(suffix)
	result := b.String()
	if result == "" {
		return replacement
	}
	return result
}

func (p Policy) Sudo(m Message) Decision {
	if !p.allows(m) {
		return Decision{}
	}
	prefixes := p.Prefixes
	if len(p.SudoPrefixes) > 0 {
		prefixes = p.SudoPrefixes
	}
	cmd := Parse(m.Text, prefixes, p.Aliases)
	if cmd == "" {
		return Decision{}
	}
	return Decision{Send: true, Text: m.Text, Command: cmd, ReplyTo: reply(m), CopyEntities: true}
}

func (p Policy) Sure(m Message) Decision {
	if !p.allows(m) {
		return Decision{}
	}
	for _, rule := range p.Rules {
		text := m.Text
		if prefix, ok := strings.CutPrefix(rule.Message, "_command:"); ok {
			suffix, matched := strings.CutPrefix(m.Text, prefix)
			if !matched || (suffix != "" && !strings.HasPrefix(suffix, " ")) {
				continue
			}
			if rule.Redirect != "" {
				text = replacePrefix(prefix, suffix, rule.Redirect)
			}
		} else {
			if rule.Message != m.Text {
				continue
			}
			if rule.Redirect != "" {
				text = rule.Redirect
			}
		}
		return Decision{Send: true, Text: text, Command: Parse(text, p.Prefixes, p.Aliases), ReplyTo: reply(m), DeleteDelayMS: 5000}
	}
	return Decision{}
}
