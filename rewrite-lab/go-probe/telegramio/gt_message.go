package telegramio

import (
	"context"
	"errors"

	"github.com/gotd/td/telegram/message"
	"github.com/gotd/td/telegram/message/html"
	"github.com/gotd/td/tg"
	"telebox.local/rewrite-probe/plugins/gt"
)

type GTMessage struct {
	api         *tg.Client
	sender      *message.Sender
	peer        tg.InputPeerClass
	id, replyID int
}

var _ gt.Message = (*GTMessage)(nil)

// NewGTMessage requires an already resolved peer with its access hash. The
// caller owns authorization and must treat the supplied peer as immutable.
func NewGTMessage(api *tg.Client, peer tg.InputPeerClass, id, replyID int) (*GTMessage, error) {
	if api == nil || id <= 0 || replyID < 0 {
		return nil, errors.New("GT message requires client and valid message IDs")
	}
	switch p := peer.(type) {
	case *tg.InputPeerUser:
		if p == nil {
			return nil, errors.New("nil user peer")
		}
	case *tg.InputPeerChat:
		if p == nil {
			return nil, errors.New("nil chat peer")
		}
	case *tg.InputPeerChannel:
		if p == nil {
			return nil, errors.New("nil channel peer")
		}
	case *tg.InputPeerSelf:
		if p == nil {
			return nil, errors.New("nil self peer")
		}
	default:
		return nil, errors.New("GT peer requires another resolver")
	}
	return &GTMessage{api: api, sender: message.NewSender(api), peer: peer, id: id, replyID: replyID}, nil
}

func (m *GTMessage) ReplyText(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if m.replyID == 0 {
		return "", nil
	}
	ids := []tg.InputMessageClass{&tg.InputMessageID{ID: m.replyID}}
	var result tg.MessagesMessagesClass
	var err error
	if peer, ok := m.peer.(*tg.InputPeerChannel); ok {
		result, err = m.api.ChannelsGetMessages(ctx, &tg.ChannelsGetMessagesRequest{Channel: &tg.InputChannel{ChannelID: peer.ChannelID, AccessHash: peer.AccessHash}, ID: ids})
	} else {
		result, err = m.api.MessagesGetMessages(ctx, ids)
	}
	if err != nil {
		return "", err
	}
	modified, ok := result.AsModified()
	if !ok {
		return "", errors.New("reply query returned no message collection")
	}
	for _, value := range modified.GetMessages() {
		if msg, ok := value.(*tg.Message); ok && msg.ID == m.replyID {
			return msg.Message, nil
		}
	}
	return "", nil
}

func (m *GTMessage) EditHTML(ctx context.Context, text string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	_, err := m.sender.To(m.peer).Edit(m.id).StyledText(ctx, html.String(nil, text))
	return err
}

func (m *GTMessage) ReplyHTML(ctx context.Context, text string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	_, err := m.sender.To(m.peer).Reply(m.id).StyledText(ctx, html.String(nil, text))
	return err
}
