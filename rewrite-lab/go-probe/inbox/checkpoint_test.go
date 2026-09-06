package inbox

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/gotd/td/telegram/updates"
)

func TestCheckpointStateReopenAndMissingAccount(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "state.sqlite")
	s := openTest(t, path, 1024)
	if _, found, err := s.GetState(ctx, 101); err != nil || found {
		t.Fatal("missing state reported present")
	}
	for _, write := range []func() error{
		func() error { return s.SetPts(ctx, 101, 1) }, func() error { return s.SetQts(ctx, 101, 1) },
		func() error { return s.SetDate(ctx, 101, 1) }, func() error { return s.SetSeq(ctx, 101, 1) },
		func() error { return s.SetDateSeq(ctx, 101, 1, 2) },
	} {
		if err := write(); !errors.Is(err, sql.ErrNoRows) {
			t.Fatal("missing account silently created")
		}
	}
	if err := s.SetState(ctx, 101, updates.State{Pts: 1, Qts: 2, Date: 3, Seq: 4}); err != nil {
		t.Fatal(err)
	}
	for _, write := range []func() error{
		func() error { return s.SetPts(ctx, 101, 11) }, func() error { return s.SetQts(ctx, 101, 12) },
		func() error { return s.SetDate(ctx, 101, 13) }, func() error { return s.SetSeq(ctx, 101, 14) },
		func() error { return s.SetDateSeq(ctx, 101, 23, 24) },
	} {
		if err := write(); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s = openTest(t, path, 1024)
	state, found, err := s.GetState(ctx, 101)
	if err != nil || !found || state != (updates.State{Pts: 11, Qts: 12, Date: 23, Seq: 24}) {
		t.Fatalf("restored %+v found=%v err=%v", state, found, err)
	}
}

func TestCheckpointHashesAndReentrantChannelIteration(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	path := filepath.Join(t.TempDir(), "state.sqlite")
	s := openTest(t, path, 1024)
	channel, hash := int64(9007199254740993), int64(-9223372036854775807)
	if err := s.SetChannelPts(ctx, 101, channel, 77); err != nil {
		t.Fatal(err)
	}
	if err := s.SetChannelAccessHash(ctx, 101, channel, hash); err != nil {
		t.Fatal(err)
	}
	if err := s.SetUserAccessHash(ctx, 101, channel, 123); err != nil {
		t.Fatal(err)
	}
	if err := s.SetChannelPts(ctx, 102, channel, 88); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s = openTest(t, path, 1024)
	calls := 0
	err := s.ForEachChannels(ctx, 101, func(ctx context.Context, id int64, pts int) error {
		calls++
		got, found, err := s.GetChannelAccessHash(ctx, 101, id)
		if err != nil {
			return err
		}
		if !found || got != hash || id != channel || pts != 77 {
			t.Error("channel/hash precision lost")
		}
		return nil
	})
	if err != nil || calls != 1 {
		t.Fatalf("iteration failed/deadlocked: %v calls=%d", err, calls)
	}
	if h, found, err := s.GetUserAccessHash(ctx, 101, channel); err != nil || !found || h != 123 {
		t.Fatal("peer kinds conflated")
	}
	if _, found, err := s.GetChannelAccessHash(ctx, 102, channel); err != nil || found {
		t.Fatal("hash leaked across accounts")
	}
	if pts, found, err := s.GetChannelPts(ctx, 102, channel); err != nil || !found || pts != 88 {
		t.Fatal("account checkpoints conflated")
	}
}

func TestUpgradeInboxV1PreservesEvents(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "v1.sqlite")
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE inbox(sequence INTEGER PRIMARY KEY,account TEXT NOT NULL,event_key TEXT NOT NULL,payload BLOB NOT NULL,digest BLOB NOT NULL,done INTEGER NOT NULL DEFAULT 0 CHECK(done IN(0,1)),UNIQUE(account,event_key)); PRAGMA user_version=1;`)
	if err != nil {
		db.Close()
		t.Fatal(err)
	}
	payload := []byte("v1 event")
	digest := sha256.Sum256(payload)
	for i := 0; i < 2; i++ {
		if _, err := db.Exec("INSERT INTO inbox(account,event_key,payload,digest,done)VALUES(?,?,?,?,?)", "101", i, payload, digest[:], i); err != nil {
			db.Close()
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	s := openTest(t, path, 1024)
	events, err := s.Pending(ctx, 10)
	if err != nil || len(events) != 1 || string(events[0].Payload) != "v1 event" {
		t.Fatalf("v1 data lost: %+v %v", events, err)
	}
	if err := s.SetState(ctx, 101, updates.State{Pts: 10}); err != nil {
		t.Fatal(err)
	}
	var count, done, version int
	if err := s.db.QueryRow("SELECT count(*),sum(done)FROM inbox").Scan(&count, &done); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if count != 2 || done != 1 || version != 2 {
		t.Fatalf("migration count=%d done=%d version=%d", count, done, version)
	}
}
