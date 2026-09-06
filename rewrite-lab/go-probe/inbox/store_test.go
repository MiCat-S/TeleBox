package inbox

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
)

func openTest(t *testing.T, path string, quota int64) *Store {
	t.Helper()
	s, err := Open(context.Background(), path, quota)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestInboxReopenAndDeduplicate(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "inbox.sqlite")
	s := openTest(t, path, 1024)
	id, err := s.Put(ctx, "101", "message:202:12", []byte{0, 1, 255})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s = openTest(t, path, 1024)
	pending, err := s.Pending(ctx, 10)
	if err != nil || len(pending) != 1 || pending[0].Sequence != id || string(pending[0].Payload) != string([]byte{0, 1, 255}) {
		t.Fatalf("recovery failed: %+v %v", pending, err)
	}
	if again, err := s.Put(ctx, "101", "message:202:12", []byte{0, 1, 255}); err != nil || again != id {
		t.Fatal("replay duplicated event")
	}
	if _, err := s.Put(ctx, "101", "message:202:12", []byte("different")); !errors.Is(err, ErrConflict) {
		t.Fatal("conflicting payload overwritten")
	}
	if err := s.Complete(ctx, id); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s = openTest(t, path, 1024)
	if _, err := s.Put(ctx, "101", "message:202:12", []byte{0, 1, 255}); err != nil {
		t.Fatal(err)
	}
	if pending, err := s.Pending(ctx, 10); err != nil || len(pending) != 0 {
		t.Fatal("completed event replayed")
	}
}

func TestInboxQuotaAndAccountIdentity(t *testing.T) {
	ctx := context.Background()
	s := openTest(t, filepath.Join(t.TempDir(), "inbox.sqlite"), 6)
	first, err := s.Put(ctx, "101", "same", []byte("abc"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.Put(ctx, "102", "same", []byte("def"))
	if err != nil || second == first {
		t.Fatal("accounts conflated")
	}
	if _, err := s.Put(ctx, "101", "overflow", []byte("x")); !errors.Is(err, ErrFull) {
		t.Fatal("quota not enforced")
	}
	if _, err := s.Put(ctx, "101", "same", []byte("abc")); err != nil {
		t.Fatal("duplicate needs extra capacity")
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if err := s.Complete(canceled, first); err == nil {
		t.Fatal("canceled completion succeeded")
	}
	if pending, err := s.Pending(ctx, 10); err != nil || len(pending) != 2 {
		t.Fatal("failed operation changed pending events")
	}
}

func TestInboxConcurrentConnectionsDeduplicate(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "inbox.sqlite")
	stores := []*Store{openTest(t, path, 1024), openTest(t, path, 1024)}
	var wg sync.WaitGroup
	ids := make(chan int64, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(s *Store) {
			defer wg.Done()
			id, err := s.Put(ctx, "101", "same", []byte("payload"))
			if err != nil {
				t.Error(err)
				return
			}
			ids <- id
		}(stores[i%2])
	}
	wg.Wait()
	close(ids)
	var first int64
	for id := range ids {
		if first == 0 {
			first = id
		}
		if first != id {
			t.Error("duplicate identity inserted twice")
		}
	}
	if pending, err := stores[0].Pending(ctx, 10); err != nil || len(pending) != 1 {
		t.Fatal("duplicate records persisted")
	}
}

func TestInboxProcessExitRecovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "inbox.sqlite")
	cmd := exec.Command(os.Args[0], "-test.run=^TestInboxExitHelper$")
	cmd.Env = append(os.Environ(), "TELEBOX_SYNTHETIC_INBOX="+path)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("child: %s %v", output, err)
	}
	s := openTest(t, path, 1024)
	pending, err := s.Pending(context.Background(), 10)
	if err != nil || len(pending) != 1 || string(pending[0].Payload) != "synthetic TL payload" {
		t.Fatalf("exit recovery: %+v %v", pending, err)
	}
}

func TestInboxExitHelper(t *testing.T) {
	path := os.Getenv("TELEBOX_SYNTHETIC_INBOX")
	if path == "" {
		t.Skip("subprocess helper")
	}
	s, err := Open(context.Background(), path, 1024)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Put(context.Background(), "101", "event", []byte("synthetic TL payload")); err != nil {
		t.Fatal(err)
	}
	// Exit after durable commit, without calling database Close or Go cleanups.
	os.Exit(0)
}

func TestInboxReadIntegrityAndMissingCompletion(t *testing.T) {
	ctx := context.Background()
	s := openTest(t, filepath.Join(t.TempDir(), "inbox.sqlite"), 1024)
	id, err := s.Put(ctx, "101", "event", []byte("payload"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Complete(ctx, id+1); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("missing event marked complete")
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE inbox SET payload=? WHERE sequence=?", []byte("damaged"), id); err != nil {
		t.Fatal(err)
	}
	if events, err := s.Pending(ctx, 10); !errors.Is(err, ErrCorrupt) || len(events) != 0 {
		t.Fatal("corrupt payload delivered")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Put(ctx, "101", "later", []byte("x")); err == nil {
		t.Fatal("closed store acknowledged event")
	}
}
