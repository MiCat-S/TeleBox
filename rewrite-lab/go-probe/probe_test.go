package probe

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"net"
	"testing"

	"github.com/gotd/td/bin"
	"github.com/gotd/td/session"
	"github.com/gotd/td/tg"
)

// Only synthetic keys are used. No network client is started.
func TestSyntheticSessionImport(t *testing.T) {
	for _, address := range []string{"149.154.167.51", "2001:db8::1"} {
		t.Run(address, func(t *testing.T) {
			ip := net.ParseIP(address)
			if v4 := ip.To4(); v4 != nil {
				ip = v4
			}
			key := bytes.Repeat([]byte{0xa5}, 256)
			raw := append([]byte{2}, ip...)
			raw = binary.BigEndian.AppendUint16(raw, 443)
			raw = append(raw, key...)
			data, err := session.TelethonSession("1" + base64.URLEncoding.EncodeToString(raw))
			if err != nil {
				t.Fatal(err)
			}
			if data.DC != 2 || data.Addr != net.JoinHostPort(address, "443") || !bytes.Equal(data.AuthKey, key) {
				t.Fatal("session fields differ")
			}
			store := &memoryStore{}
			loader := session.Loader{Storage: store}
			if err := loader.Save(context.Background(), data); err != nil {
				t.Fatal(err)
			}
			loaded, err := loader.Load(context.Background())
			if err != nil || !bytes.Equal(loaded.AuthKey, key) || loaded.Addr != data.Addr {
				t.Fatal("native storage round trip failed", err)
			}
		})
	}
}

func TestMalformedSessionRejected(t *testing.T) {
	for _, input := range []string{"", "2bad", "1bad", "1" + base64.URLEncoding.EncodeToString([]byte{1, 2})} {
		if _, err := session.TelethonSession(input); err == nil {
			t.Fatalf("accepted malformed synthetic input")
		}
	}
}

func TestRequiredRPCSerialization(t *testing.T) {
	peer := &tg.InputPeerSelf{}
	requests := []bin.Encoder{
		&tg.MessagesGetHistoryRequest{Peer: peer, Limit: 10},
		&tg.MessagesEditMessageRequest{Peer: peer, ID: 1},
		&tg.MessagesDeleteMessagesRequest{ID: []int{1}},
		&tg.ChannelsGetSendAsRequest{Peer: peer},
		&tg.MessagesGetBotCallbackAnswerRequest{Peer: peer, MsgID: 1},
		&tg.UploadSaveFilePartRequest{FileID: 1, Bytes: []byte("synthetic")},
		&tg.UpdatesGetStateRequest{},
	}
	for _, request := range requests {
		b := &bin.Buffer{}
		if err := request.Encode(b); err != nil {
			t.Fatalf("%T: %v", request, err)
		}
		if len(b.Buf) < 4 {
			t.Fatalf("%T encoded no constructor", request)
		}
	}
}

func TestCallbackBinaryRoundTrip(t *testing.T) {
	// This release exposes the older keyboardButtonCallback constructor.
	want := &tg.KeyboardButtonCallback{Text: "callback", Data: []byte{0, 255, 1}}
	b := &bin.Buffer{}
	if err := want.Encode(b); err != nil {
		t.Fatal(err)
	}
	got := &tg.KeyboardButtonCallback{}
	if err := got.Decode(b); err != nil {
		t.Fatal(err)
	}
	if got.Text != want.Text || !bytes.Equal(got.Data, want.Data) {
		t.Fatal("callback payload changed")
	}
}

type memoryStore struct{ data []byte }

func (m *memoryStore) LoadSession(context.Context) ([]byte, error) {
	return append([]byte(nil), m.data...), nil
}
func (m *memoryStore) StoreSession(_ context.Context, data []byte) error {
	m.data = append([]byte(nil), data...)
	return nil
}
