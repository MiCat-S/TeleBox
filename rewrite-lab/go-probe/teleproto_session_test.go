package probe

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"os/exec"
	"strconv"
	"testing"
	"time"

	"github.com/gotd/td/session"
)

// Test-only bridge for the inspected Teleproto StringSession encoding.
func importSyntheticTeleproto(input string) (*session.Data, error) {
	if len(input) < 2 || input[0] != '1' {
		return nil, fmt.Errorf("invalid version")
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(input[1:])
	if err != nil {
		return nil, err
	}
	if len(raw) < 5 {
		return nil, fmt.Errorf("short header")
	}
	size := int(binary.BigEndian.Uint16(raw[1:3]))
	if len(raw) != 5+size+256 {
		return nil, fmt.Errorf("invalid payload length")
	}
	ip := net.ParseIP(string(raw[3 : 3+size]))
	if ip == nil {
		return nil, fmt.Errorf("IP fixture required")
	}
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	packed := append([]byte{raw[0]}, ip...)
	packed = append(packed, raw[3+size:]...)
	return session.TelethonSession("1" + base64.URLEncoding.EncodeToString(packed))
}

func TestCurrentTeleprotoToGotdSession(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "node", "../synthetic-session.cjs").Output()
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Synthetic bool `json:"synthetic"`
		Fixtures  []struct {
			Address   string `json:"address"`
			DC        int    `json:"dc"`
			Port      int    `json:"port"`
			Teleproto string `json:"teleproto"`
		} `json:"fixtures"`
	}
	if err := json.Unmarshal(output, &fixture); err != nil {
		t.Fatal(err)
	}
	if !fixture.Synthetic || len(fixture.Fixtures) != 2 {
		t.Fatal("unexpected fixture scope")
	}
	for _, f := range fixture.Fixtures {
		data, err := importSyntheticTeleproto(f.Teleproto)
		if err != nil {
			t.Fatal(err)
		}
		if data.DC != f.DC || data.Addr != net.JoinHostPort(f.Address, strconv.Itoa(f.Port)) ||
			!bytes.Equal(data.AuthKey, bytes.Repeat([]byte{0xa5}, 256)) || len(data.AuthKeyID) != 8 {
			t.Fatal("imported session fields differ")
		}
		loader := session.Loader{Storage: &memoryStore{}}
		if err := loader.Save(ctx, data); err != nil {
			t.Fatal(err)
		}
		restored, err := loader.Load(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(restored.AuthKey, data.AuthKey) || !bytes.Equal(restored.AuthKeyID, data.AuthKeyID) {
			t.Fatal("key changed across native storage")
		}
	}
}

func TestTeleprotoBridgeRejectsIncompleteInput(t *testing.T) {
	for _, input := range []string{"", "2abc", "1invalid!", "1" + base64.StdEncoding.EncodeToString([]byte{2, 0, 1, 1})} {
		if _, err := importSyntheticTeleproto(input); err == nil {
			t.Fatal("malformed session accepted")
		}
	}
}
