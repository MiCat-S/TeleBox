package telegramio

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gotd/td/bin"
	"github.com/gotd/td/tg"
	"telebox.local/rewrite-probe/aiconfig"
	"telebox.local/rewrite-probe/command"
	"telebox.local/rewrite-probe/inbox"
	"telebox.local/rewrite-probe/plugins/gt"
)

type fixtureInvoker func(context.Context, bin.Encoder, bin.Decoder) error

func (f fixtureInvoker) Invoke(ctx context.Context, input bin.Encoder, output bin.Decoder) error {
	return f(ctx, input, output)
}
func returnTL(value bin.Encoder, output bin.Decoder) error {
	b := new(bin.Buffer)
	if err := value.Encode(b); err != nil {
		return err
	}
	return output.Decode(b)
}

func TestGTMessageEditAndReplyEntities(t *testing.T) {
	var edits, replies int
	api := tg.NewClient(fixtureInvoker(func(ctx context.Context, input bin.Encoder, output bin.Decoder) error {
		b := new(bin.Buffer)
		if err := input.Encode(b); err != nil {
			return err
		}
		switch input.(type) {
		case *tg.MessagesEditMessageRequest:
			var req tg.MessagesEditMessageRequest
			if err := req.Decode(b); err != nil {
				return err
			}
			if req.ID != 12 || req.Peer.(*tg.InputPeerUser).AccessHash != 456 {
				t.Error("edit target differs")
			}
			if req.Message != "😀 bold <safe>" {
				t.Errorf("text=%q", req.Message)
			}
			if len(req.Entities) != 1 {
				t.Fatal("bold entity missing")
			}
			entity := req.Entities[0].(*tg.MessageEntityBold)
			if entity.Offset != 3 || entity.Length != 4 {
				t.Errorf("UTF16 entity=%+v", entity)
			}
			edits++
		case *tg.MessagesSendMessageRequest:
			var req tg.MessagesSendMessageRequest
			if err := req.Decode(b); err != nil {
				return err
			}
			if req.Message != "remaining & text" || req.RandomID == 0 || req.ReplyTo.(*tg.InputReplyToMessage).ReplyToMsgID != 12 {
				t.Error("reply differs")
			}
			replies++
		default:
			t.Fatalf("unexpected RPC %T", input)
		}
		return returnTL(&tg.Updates{}, output)
	}))
	m, err := NewGTMessage(api, &tg.InputPeerUser{UserID: 123, AccessHash: 456}, 12, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.EditHTML(context.Background(), "😀 <b>bold</b> &lt;safe&gt;"); err != nil {
		t.Fatal(err)
	}
	if err := m.ReplyHTML(context.Background(), "remaining &amp; text"); err != nil {
		t.Fatal(err)
	}
	if edits != 1 || replies != 1 {
		t.Fatal("RPC count differs")
	}
}

func TestGTMessageChannelReplyAndTranslation(t *testing.T) {
	var edits, reads, sends int
	api := tg.NewClient(fixtureInvoker(func(ctx context.Context, input bin.Encoder, output bin.Decoder) error {
		switch req := input.(type) {
		case *tg.ChannelsGetMessagesRequest:
			channel := req.Channel.(*tg.InputChannel)
			if channel.ChannelID != 202 || channel.AccessHash != 303 || req.ID[0].(*tg.InputMessageID).ID != 11 {
				t.Error("reply lookup differs")
			}
			reads++
			return returnTL(&tg.MessagesMessages{Messages: []tg.MessageClass{&tg.Message{ID: 11, PeerID: &tg.PeerChannel{ChannelID: 202}, Message: "hello"}}}, output)
		case *tg.MessagesEditMessageRequest:
			edits++
			if req.ID != 12 {
				t.Error("wrong edited message")
			}
			if edits == 2 && !strings.HasSuffix(req.Message, strings.Repeat("a", 3000)) {
				t.Error("translation missing")
			}
		case *tg.MessagesSendMessageRequest:
			sends++
			if req.Message != "😀" || req.ReplyTo.(*tg.InputReplyToMessage).ReplyToMsgID != 12 {
				t.Error("translation continuation differs")
			}
		default:
			t.Fatalf("unexpected RPC %T", input)
		}
		return returnTL(&tg.Updates{}, output)
	}))
	m, err := NewGTMessage(api, &tg.InputPeerChannel{ChannelID: 202, AccessHash: 303}, 12, 11)
	if err != nil {
		t.Fatal(err)
	}
	err = gt.Handle(context.Background(), ".gt", m, func(_ context.Context, text, target string) (string, error) {
		if text != "hello" || target != "zh-CN" {
			t.Error("translation input differs")
		}
		return strings.Repeat("a", 3000) + "😀", nil
	})
	if err != nil || reads != 1 || edits != 2 || sends != 1 {
		t.Fatalf("reads=%d edits=%d sends=%d err=%v", reads, edits, sends, err)
	}
}

func TestGTMessageNoReplyAndCancellation(t *testing.T) {
	api := tg.NewClient(fixtureInvoker(func(context.Context, bin.Encoder, bin.Decoder) error { t.Error("unexpected RPC"); return nil }))
	m, err := NewGTMessage(api, &tg.InputPeerSelf{}, 12, 0)
	if err != nil {
		t.Fatal(err)
	}
	if text, err := m.ReplyText(context.Background()); text != "" || err != nil {
		t.Fatal(text, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := m.EditHTML(ctx, "text"); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if err := m.ReplyHTML(ctx, "text"); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestNormalizedCommandConfigHTTPAndTelegramEdit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []struct{ Role, Content string }
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if len(body.Messages) != 2 || body.Messages[1].Content != "你好" {
			t.Error("AI input differs")
		}
		w.Write([]byte(`{"choices":[{"message":{"content":"<Hello>"}}]}`))
	}))
	defer server.Close()
	configBytes, err := json.Marshal(map[string]any{
		"configs":        map[string]any{"test": map[string]any{"type": "openai", "url": server.URL, "key": "synthetic"}},
		"currentChatTag": "test", "currentChatModel": "fixture-model", "timeout": 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	config, err := aiconfig.Parse(configBytes)
	if err != nil {
		t.Fatal(err)
	}
	chat, err := config.BuildChat(server.Client().Transport, 4096)
	if err != nil {
		t.Fatal(err)
	}
	var outputs []string
	api := tg.NewClient(fixtureInvoker(func(_ context.Context, input bin.Encoder, output bin.Decoder) error {
		req, ok := input.(*tg.MessagesEditMessageRequest)
		if !ok {
			return errors.New("unexpected translation RPC")
		}
		outputs = append(outputs, req.Message)
		if req.ID != 12 || req.Peer.(*tg.InputPeerUser).UserID != 202 {
			t.Error("wrong Telegram destination")
		}
		return returnTL(&tg.Updates{}, output)
	}))
	cache, err := inbox.Open(context.Background(), filepath.Join(t.TempDir(), "peers.sqlite"), 1024)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Close()
	if err := cache.SetUserAccessHash(context.Background(), 101, 202, 303); err != nil {
		t.Fatal(err)
	}
	peer, err := ResolvePeer(context.Background(), 101, cache, &tg.PeerUser{UserID: 202})
	if err != nil {
		t.Fatal(err)
	}
	port, err := NewGTMessage(api, peer, 12, 0)
	if err != nil {
		t.Fatal(err)
	}
	dispatcher := command.NewDispatcher([]string{"."}, nil, map[string]command.Entry{"gt": {Handler: func(ctx context.Context, inv command.Invocation) error {
		return gt.Handle(ctx, inv.Message.Text, port, chat.Translate)
	}}})
	m := &tg.Message{ID: 12, PeerID: &tg.PeerUser{UserID: 202}, Out: true, Message: ".gt en 你好"}
	m.SetFromID(&tg.PeerUser{UserID: 101})
	u, err := NormalizeUpdate(&tg.UpdateNewMessage{Message: m})
	if err != nil {
		t.Fatal(err)
	}
	if called, err := dispatcher.Primary(context.Background(), u); err != nil || !called {
		t.Fatal("dispatch failed", err)
	}
	if len(outputs) != 2 || !strings.HasSuffix(outputs[1], "<Hello>") {
		t.Fatal(outputs)
	}
}
