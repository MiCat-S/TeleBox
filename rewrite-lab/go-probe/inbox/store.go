// Package inbox provides a candidate durable business inbox, separate from PTS.
package inbox

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"net/url"
	"os"
	"path/filepath"

	_ "github.com/mattn/go-sqlite3"
)

var ErrConflict = errors.New("event identity reused with different payload")
var ErrFull = errors.New("inbox retained payload quota reached")
var ErrCorrupt = errors.New("inbox payload digest mismatch")

type Store struct {
	db    *sql.DB
	quota int64
}
type Event struct {
	Sequence     int64
	Account, Key string
	Payload      []byte
}

// Open requires a dedicated path. Retained payload quota includes completed
// entries, which remain for deduplication; it is not a physical disk-size cap.
func Open(ctx context.Context, path string, quota int64) (*Store, error) {
	if quota <= 0 {
		return nil, errors.New("positive inbox quota required")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	f, err := os.OpenFile(abs, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	u := url.URL{Scheme: "file", Path: abs}
	q := u.Query()
	q.Set("_journal_mode", "WAL")
	q.Set("_synchronous", "FULL")
	q.Set("_busy_timeout", "5000")
	q.Set("_txlock", "immediate")
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite3", u.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db, quota: quota}
	if err := s.init(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) init(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var version int
	if err := tx.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version == 2 {
		return tx.Commit()
	}
	if version != 0 && version != 1 {
		return errors.New("unsupported inbox schema version")
	}
	if version == 0 {
		var tables int
		if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").Scan(&tables); err != nil {
			return err
		}
		if tables != 0 {
			return errors.New("inbox path is not an empty dedicated database")
		}
		if _, err := tx.ExecContext(ctx, `CREATE TABLE inbox (
 sequence INTEGER PRIMARY KEY, account TEXT NOT NULL, event_key TEXT NOT NULL,
 payload BLOB NOT NULL, digest BLOB NOT NULL, done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)),
 UNIQUE(account,event_key)); PRAGMA user_version=1;`); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `CREATE TABLE account_state (
 user_id INTEGER PRIMARY KEY, pts INTEGER NOT NULL, qts INTEGER NOT NULL, date INTEGER NOT NULL, seq INTEGER NOT NULL);
 CREATE TABLE channel_state (user_id INTEGER NOT NULL, channel_id INTEGER NOT NULL, pts INTEGER NOT NULL, PRIMARY KEY(user_id,channel_id));
 CREATE TABLE peer_hash (user_id INTEGER NOT NULL, target_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('user','channel')), access_hash INTEGER NOT NULL, PRIMARY KEY(user_id,target_id,kind));
 PRAGMA user_version=2;`); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) Close() error { return s.db.Close() }

// Put returns only after commit. Identical replay is idempotent, including
// completed entries; conflicting identities are surfaced, never overwritten.
func (s *Store) Put(ctx context.Context, account, key string, payload []byte) (int64, error) {
	if account == "" || key == "" || len(payload) == 0 {
		return 0, errors.New("event account, key and payload required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	digest := sha256.Sum256(payload)
	var sequence int64
	var existing []byte
	err = tx.QueryRowContext(ctx, "SELECT sequence,digest FROM inbox WHERE account=? AND event_key=?", account, key).Scan(&sequence, &existing)
	if err == nil {
		if !bytes.Equal(existing, digest[:]) {
			return 0, ErrConflict
		}
		return sequence, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	var used int64
	if err := tx.QueryRowContext(ctx, "SELECT coalesce(sum(length(payload)),0) FROM inbox").Scan(&used); err != nil {
		return 0, err
	}
	if int64(len(payload)) > s.quota-used {
		return 0, ErrFull
	}
	result, err := tx.ExecContext(ctx, "INSERT INTO inbox(account,event_key,payload,digest) VALUES(?,?,?,?)", account, key, payload, digest[:])
	if err != nil {
		return 0, err
	}
	sequence, err = result.LastInsertId()
	if err != nil {
		return 0, err
	}
	return sequence, tx.Commit()
}

// Pending is a read, not a claim. This prototype requires one consumer; callers
// must not launch the same batch concurrently or assume exactly-once effects.
func (s *Store) Pending(ctx context.Context, limit int) ([]Event, error) {
	if limit < 1 || limit > 1000 {
		return nil, errors.New("batch limit must be 1..1000")
	}
	rows, err := s.db.QueryContext(ctx, "SELECT sequence,account,event_key,payload,digest FROM inbox WHERE done=0 ORDER BY sequence LIMIT ?", limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []Event
	for rows.Next() {
		var e Event
		var digest []byte
		if err := rows.Scan(&e.Sequence, &e.Account, &e.Key, &e.Payload, &digest); err != nil {
			return nil, err
		}
		expected := sha256.Sum256(e.Payload)
		if !bytes.Equal(digest, expected[:]) {
			return nil, ErrCorrupt
		}
		events = append(events, e)
	}
	return events, rows.Err()
}

func (s *Store) Complete(ctx context.Context, sequence int64) error {
	result, err := s.db.ExecContext(ctx, "UPDATE inbox SET done=1 WHERE sequence=?", sequence)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return sql.ErrNoRows
	}
	return nil
}
