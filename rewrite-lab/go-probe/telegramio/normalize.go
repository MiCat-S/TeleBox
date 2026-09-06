// Package telegramio adapts fixed-version gotd types to the candidate runtime.
package telegramio

import (
	"errors"
	"strconv"

	"github.com/gotd/td/tg"
	"telebox.local/rewrite-probe/command"
)

var ErrUnsupportedUpdate = errors.New("update requires another handler or expansion")
var ErrNonTextMessage = errors.New("message class is not an ordinary message")

// Raw peer IDs match the baseline sudo/sure database convention, not marked
// -100 channel IDs. Peer kind and access hashes remain transport concerns.
func peerID(peer tg.PeerClass) string {
	switch p := peer.(type) {
	case *tg.PeerUser:
		if p != nil {
			return strconv.FormatInt(p.UserID, 10)
		}
	case *tg.PeerChat:
		if p != nil {
			return strconv.FormatInt(p.ChatID, 10)
		}
	case *tg.PeerChannel:
		if p != nil {
			return strconv.FormatInt(p.ChannelID, 10)
		}
	}
	return ""
}

func NormalizeMessage(value tg.MessageClass, edited bool) (command.Envelope, error) {
	m, ok := value.(*tg.Message)
	if !ok || m == nil {
		return command.Envelope{}, ErrNonTextMessage
	}
	_, forwarded := m.GetFwdFrom()
	e := command.Envelope{
		Message: command.Message{Text: m.Message, UserID: peerID(m.FromID), ChatID: peerID(m.PeerID), Forwarded: forwarded},
		Out:     m.Out, Saved: m.SavedPeerID != nil, Edited: edited, Native: m,
	}
	if reply, ok := m.ReplyTo.(*tg.MessageReplyHeader); ok && reply != nil {
		e.Reply = int64(reply.ReplyToMsgID)
		if reply.ForumTopic {
			e.Topic = int64(reply.ReplyToTopID)
		}
	}
	return e, nil
}

// Short updates, service events and non-message updates must be handled by
// their own adapter. This function never acknowledges an update or persists PTS.
func NormalizeUpdate(update tg.UpdateClass) (command.Envelope, error) {
	switch u := update.(type) {
	case *tg.UpdateNewMessage:
		if u != nil {
			return NormalizeMessage(u.Message, false)
		}
	case *tg.UpdateNewChannelMessage:
		if u != nil {
			return NormalizeMessage(u.Message, false)
		}
	case *tg.UpdateEditMessage:
		if u != nil {
			return NormalizeMessage(u.Message, true)
		}
	case *tg.UpdateEditChannelMessage:
		if u != nil {
			return NormalizeMessage(u.Message, true)
		}
	}
	return command.Envelope{}, ErrUnsupportedUpdate
}
