package command

import (
	"encoding/json"
	"os"
	"testing"
)

func TestSharedPermissionCases(t *testing.T) {
	raw, err := os.ReadFile("../../permission-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Defaults json.RawMessage
		Cases    []json.RawMessage
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, rawCase := range fixture.Cases {
		var c struct {
			Name, Plugin, Text, SudoPrefix string
			UID, CID                       *json.Number
			Users, Chats                   []json.Number
			Forwarded                      bool
			Topic, Reply, ReplyTo          int64
			Rules                          []Rule
			Send, Command                  *string
			DeleteDelay                    int
		}
		if err := json.Unmarshal(fixture.Defaults, &c); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(rawCase, &c); err != nil {
			t.Fatal(err)
		}
		t.Run(c.Name, func(t *testing.T) {
			p := Policy{Prefixes: []string{"."}, Rules: c.Rules}
			for _, id := range c.Users {
				p.Users = append(p.Users, id.String())
			}
			for _, id := range c.Chats {
				p.Chats = append(p.Chats, id.String())
			}
			if c.SudoPrefix != "" {
				p.SudoPrefixes = []string{c.SudoPrefix}
			}
			m := Message{Text: c.Text, Forwarded: c.Forwarded, Topic: c.Topic, Reply: c.Reply}
			if c.UID != nil {
				m.UserID = c.UID.String()
			}
			if c.CID != nil {
				m.ChatID = c.CID.String()
			}
			var d Decision
			switch c.Plugin {
			case "sudo":
				d = p.Sudo(m)
			case "sure":
				d = p.Sure(m)
			default:
				t.Fatal("unknown plugin")
			}
			want := Decision{}
			if c.Send != nil {
				want = Decision{Send: true, Text: *c.Send, ReplyTo: c.ReplyTo, DeleteDelayMS: c.DeleteDelay, CopyEntities: c.Plugin == "sudo"}
				if c.Command != nil {
					want.Command = *c.Command
				}
			}
			if d != want {
				t.Fatalf("got %+v want %+v", d, want)
			}
		})
	}
}

func TestParseAliasPrefixAndWhitespace(t *testing.T) {
	aliases := map[string]bool{"go": true, "go now": true}
	for _, c := range [][2]string{{".go now extra", "go now"}, {".go later", "go"}, {".PING arg", "PING"}, {".", ""}, {"hello .ping", ""}, {".not-a-command", ""}, {".\ufeffping", "ping"}, {".\u0085ping", ""}} {
		if got := Parse(c[0], []string{"."}, aliases); got != c[1] {
			t.Fatalf("%q got %q want %q", c[0], got, c[1])
		}
	}
	if Parse("!!ping", []string{"!", "!!"}, nil) != "" {
		t.Fatal("prefix priority changed")
	}
}

func TestIDsRetainExactDecimalIdentity(t *testing.T) {
	p := Policy{Users: []string{"9007199254740993"}, Prefixes: []string{"."}}
	m := Message{UserID: "9007199254740992", ChatID: "202", Text: ".ping"}
	if p.Sudo(m).Send {
		t.Fatal("distinct large IDs compared equal")
	}
	m.UserID = p.Users[0]
	if !p.Sudo(m).Send {
		t.Fatal("exact ID rejected")
	}
}
