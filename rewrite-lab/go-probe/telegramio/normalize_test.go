package telegramio

import (
	"context"
	"errors"
	"testing"

	"github.com/gotd/td/bin"
	"github.com/gotd/td/tg"
	"telebox.local/rewrite-probe/command"
)

func roundTrip(t *testing.T, u tg.UpdateClass) tg.UpdateClass {
	t.Helper()
	b := new(bin.Buffer)
	if err := u.Encode(b); err != nil {
		t.Fatal(err)
	}
	decoded, err := tg.DecodeUpdate(b)
	if err != nil {
		t.Fatal(err)
	}
	return decoded
}

func sampleMessage() *tg.Message {
	m := &tg.Message{ID: 12, Date: 1, Message: ".ping", Out: true, PeerID: &tg.PeerChannel{ChannelID: 202}}
	m.SetFromID(&tg.PeerUser{UserID: 9007199254740993})
	r := &tg.MessageReplyHeader{ForumTopic: true}
	r.SetReplyToMsgID(88)
	r.SetReplyToTopID(77)
	m.SetReplyTo(r)
	return m
}

func TestDecodedUpdatesReachCommandHandler(t *testing.T) {
	for _, edited := range []bool{false, true} {
		for _, channel := range []bool{false, true} {
			m := sampleMessage()
			var update tg.UpdateClass
			switch {
			case edited && channel:
				update = &tg.UpdateEditChannelMessage{Message: m}
			case edited:
				update = &tg.UpdateEditMessage{Message: m}
			case channel:
				update = &tg.UpdateNewChannelMessage{Message: m}
			default:
				update = &tg.UpdateNewMessage{Message: m}
			}
			e, err := NormalizeUpdate(roundTrip(t, update))
			if err != nil {
				t.Fatal(err)
			}
			if e.UserID != "9007199254740993" || e.ChatID != "202" || e.Topic != 77 || e.Reply != 88 || e.Edited != edited || !e.Out || e.Forwarded {
				t.Fatalf("metadata lost: %+v", e)
			}
			calls := 0
			d := command.NewDispatcher([]string{"."}, nil, map[string]command.Entry{"ping": {IgnoreEdited: true, Handler: func(context.Context, command.Invocation) error { calls++; return nil }}})
			called, err := d.Primary(context.Background(), e)
			if err != nil || called == edited || (calls == 1) == edited {
				t.Fatal("decoded update dispatch changed")
			}
		}
	}
}

func TestDecodedForwardAndSavedFlags(t *testing.T) {
	m := sampleMessage()
	m.Out = false
	m.SetSavedPeerID(&tg.PeerUser{UserID: 303})
	m.SetFwdFrom(tg.MessageFwdHeader{Date: 1})
	e, err := NormalizeUpdate(roundTrip(t, &tg.UpdateNewMessage{Message: m}))
	if err != nil || !e.Saved || !e.Forwarded || e.Out {
		t.Fatalf("flags lost: %+v %v", e, err)
	}
	p := command.Policy{Users: []string{e.UserID}, Prefixes: []string{"."}, Rules: []command.Rule{{Message: ".ping"}}}
	if p.Sudo(e.Message).Send || p.Sure(e.Message).Send {
		t.Fatal("forwarded authorization bypass")
	}
}

func TestMissingSenderAndOtherClasses(t *testing.T) {
	m := &tg.Message{ID: 1, Message: ".ping", PeerID: &tg.PeerChat{ChatID: 202}}
	e, err := NormalizeMessage(m, false)
	if err != nil || e.UserID != "" || e.ChatID != "202" {
		t.Fatalf("unexpected missing sender: %+v %v", e, err)
	}
	if (command.Policy{Users: []string{"101"}, Prefixes: []string{"."}}).Sudo(e.Message).Send {
		t.Fatal("sender synthesized")
	}
	if _, err := NormalizeMessage(&tg.MessageService{}, false); !errors.Is(err, ErrNonTextMessage) {
		t.Fatal("service message coerced")
	}
	if _, err := NormalizeUpdate(&tg.UpdateDeleteMessages{}); !errors.Is(err, ErrUnsupportedUpdate) {
		t.Fatal("non-message update discarded silently")
	}
	var nilUpdate *tg.UpdateNewMessage
	if _, err := NormalizeUpdate(nilUpdate); !errors.Is(err, ErrUnsupportedUpdate) {
		t.Fatal("nil update accepted")
	}
}

func TestReplyAndPeerConventions(t *testing.T) {
	for _, peer := range []tg.PeerClass{&tg.PeerUser{UserID: 202}, &tg.PeerChat{ChatID: 202}, &tg.PeerChannel{ChannelID: 202}} {
		for _, topic := range []bool{false, true} {
			for _, top := range []int{0, 77} {
				m := sampleMessage()
				m.PeerID = peer
				r := &tg.MessageReplyHeader{ForumTopic: topic}
				r.SetReplyToMsgID(88)
				if top != 0 {
					r.SetReplyToTopID(top)
				}
				m.SetReplyTo(r)
				e, err := NormalizeUpdate(roundTrip(t, &tg.UpdateNewMessage{Message: m}))
				if err != nil {
					t.Fatal(err)
				}
				p := command.Policy{Users: []string{e.UserID}, Chats: []string{"202"}, Prefixes: []string{"."}}
				d := p.Sudo(e.Message)
				want := int64(88)
				if topic && top != 0 {
					want = int64(top)
				}
				if !d.Send || d.ReplyTo != want || e.ChatID != "202" {
					t.Fatalf("peer=%T topic=%v top=%d decision=%+v", peer, topic, top, d)
				}
				if e.Native.(*tg.Message).PeerID == nil {
					t.Fatal("transport peer lost")
				}
			}
		}
	}
}
