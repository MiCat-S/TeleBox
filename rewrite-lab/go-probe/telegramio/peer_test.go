package telegramio

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/gotd/td/tg"
	"telebox.local/rewrite-probe/inbox"
)

func TestResolvePeerFromReopenedAccountCache(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "peers.sqlite")
	s, err := inbox.Open(ctx, path, 1024)
	if err != nil {
		t.Fatal(err)
	}
	const target int64 = 9007199254740993
	if err := s.SetUserAccessHash(ctx, 101, target, -444); err != nil {
		t.Fatal(err)
	}
	if err := s.SetChannelAccessHash(ctx, 101, target, 555); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = inbox.Open(ctx, path, 1024)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	user, err := ResolvePeer(ctx, 101, s, &tg.PeerUser{UserID: target})
	if err != nil {
		t.Fatal(err)
	}
	if p := user.(*tg.InputPeerUser); p.UserID != target || p.AccessHash != -444 {
		t.Fatal("user identity differs")
	}
	channel, err := ResolvePeer(ctx, 101, s, &tg.PeerChannel{ChannelID: target})
	if err != nil {
		t.Fatal(err)
	}
	if p := channel.(*tg.InputPeerChannel); p.ChannelID != target || p.AccessHash != 555 {
		t.Fatal("channel identity differs")
	}
	if _, err := ResolvePeer(ctx, 102, s, &tg.PeerUser{UserID: target}); !errors.Is(err, ErrPeerHashMissing) {
		t.Fatal("account hash leaked", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolvePeer(ctx, 101, s, &tg.PeerUser{UserID: target}); err == nil || errors.Is(err, ErrPeerHashMissing) {
		t.Fatal("storage error hidden", err)
	}
}

func TestResolveSelfChatAndMissingPeer(t *testing.T) {
	ctx := context.Background()
	self, err := ResolvePeer(ctx, 101, nil, &tg.PeerUser{UserID: 101})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := self.(*tg.InputPeerSelf); !ok {
		t.Fatal("self incorrectly resolved")
	}
	chat, err := ResolvePeer(ctx, 101, nil, &tg.PeerChat{ChatID: 202})
	if err != nil {
		t.Fatal(err)
	}
	if chat.(*tg.InputPeerChat).ChatID != 202 {
		t.Fatal("chat incorrectly resolved")
	}
	if _, err := ResolvePeer(ctx, 101, nil, &tg.PeerUser{UserID: 202}); !errors.Is(err, ErrPeerHashMissing) {
		t.Fatal(err)
	}
	for _, peer := range []tg.PeerClass{nil, (*tg.PeerUser)(nil), &tg.PeerChat{ChatID: 0}} {
		if _, err := ResolvePeer(ctx, 101, nil, peer); err == nil {
			t.Fatal("invalid peer accepted")
		}
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := ResolvePeer(canceled, 101, nil, &tg.PeerUser{UserID: 101}); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}
