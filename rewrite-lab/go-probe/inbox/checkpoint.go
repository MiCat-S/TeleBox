package inbox

import (
	"context"
	"database/sql"
	"errors"

	"github.com/gotd/td/telegram/updates"
)

var _ updates.StateStorage = (*Store)(nil)
var _ updates.ChannelAccessHasher = (*Store)(nil)
var _ updates.UserAccessHasher = (*Store)(nil)

func (s *Store) GetState(ctx context.Context, uid int64) (state updates.State, found bool, err error) {
	err = s.db.QueryRowContext(ctx, "SELECT pts,qts,date,seq FROM account_state WHERE user_id=?", uid).Scan(&state.Pts, &state.Qts, &state.Date, &state.Seq)
	if errors.Is(err, sql.ErrNoRows) {
		return state, false, nil
	}
	return state, err == nil, err
}

func (s *Store) SetState(ctx context.Context, uid int64, state updates.State) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO account_state(user_id,pts,qts,date,seq) VALUES(?,?,?,?,?)
 ON CONFLICT(user_id) DO UPDATE SET pts=excluded.pts,qts=excluded.qts,date=excluded.date,seq=excluded.seq`, uid, state.Pts, state.Qts, state.Date, state.Seq)
	return err
}

func (s *Store) updateState(ctx context.Context, query string, args ...any) error {
	result, err := s.db.ExecContext(ctx, query, args...)
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
func (s *Store) SetPts(ctx context.Context, uid int64, value int) error {
	return s.updateState(ctx, "UPDATE account_state SET pts=? WHERE user_id=?", value, uid)
}
func (s *Store) SetQts(ctx context.Context, uid int64, value int) error {
	return s.updateState(ctx, "UPDATE account_state SET qts=? WHERE user_id=?", value, uid)
}
func (s *Store) SetDate(ctx context.Context, uid int64, value int) error {
	return s.updateState(ctx, "UPDATE account_state SET date=? WHERE user_id=?", value, uid)
}
func (s *Store) SetSeq(ctx context.Context, uid int64, value int) error {
	return s.updateState(ctx, "UPDATE account_state SET seq=? WHERE user_id=?", value, uid)
}
func (s *Store) SetDateSeq(ctx context.Context, uid int64, date, seq int) error {
	return s.updateState(ctx, "UPDATE account_state SET date=?,seq=? WHERE user_id=?", date, seq, uid)
}

func (s *Store) GetChannelPts(ctx context.Context, uid, channel int64) (pts int, found bool, err error) {
	err = s.db.QueryRowContext(ctx, "SELECT pts FROM channel_state WHERE user_id=? AND channel_id=?", uid, channel).Scan(&pts)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return pts, err == nil, err
}
func (s *Store) SetChannelPts(ctx context.Context, uid, channel int64, pts int) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO channel_state(user_id,channel_id,pts) VALUES(?,?,?)
 ON CONFLICT(user_id,channel_id) DO UPDATE SET pts=excluded.pts`, uid, channel, pts)
	return err
}

func (s *Store) ForEachChannels(ctx context.Context, uid int64, fn func(context.Context, int64, int) error) error {
	rows, err := s.db.QueryContext(ctx, "SELECT channel_id,pts FROM channel_state WHERE user_id=? ORDER BY channel_id", uid)
	if err != nil {
		return err
	}
	var channels []struct {
		id  int64
		pts int
	}
	for rows.Next() {
		var c struct {
			id  int64
			pts int
		}
		if err := rows.Scan(&c.id, &c.pts); err != nil {
			rows.Close()
			return err
		}
		channels = append(channels, c)
	}
	err = rows.Err()
	closeErr := rows.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	// Callbacks may query hashes through the same single-connection database.
	for _, c := range channels {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := fn(ctx, c.id, c.pts); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) setHash(ctx context.Context, kind string, uid, target, hash int64) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO peer_hash(user_id,target_id,kind,access_hash) VALUES(?,?,?,?)
 ON CONFLICT(user_id,target_id,kind) DO UPDATE SET access_hash=excluded.access_hash`, uid, target, kind, hash)
	return err
}
func (s *Store) getHash(ctx context.Context, kind string, uid, target int64) (hash int64, found bool, err error) {
	err = s.db.QueryRowContext(ctx, "SELECT access_hash FROM peer_hash WHERE user_id=? AND target_id=? AND kind=?", uid, target, kind).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return hash, err == nil, err
}
func (s *Store) SetChannelAccessHash(ctx context.Context, uid, target, hash int64) error {
	return s.setHash(ctx, "channel", uid, target, hash)
}
func (s *Store) GetChannelAccessHash(ctx context.Context, uid, target int64) (int64, bool, error) {
	return s.getHash(ctx, "channel", uid, target)
}
func (s *Store) SetUserAccessHash(ctx context.Context, uid, target, hash int64) error {
	return s.setHash(ctx, "user", uid, target, hash)
}
func (s *Store) GetUserAccessHash(ctx context.Context, uid, target int64) (int64, bool, error) {
	return s.getHash(ctx, "user", uid, target)
}
