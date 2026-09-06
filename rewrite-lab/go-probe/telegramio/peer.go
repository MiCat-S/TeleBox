package telegramio

import (
	"context"
	"errors"

	"github.com/gotd/td/tg"
)

var ErrPeerHashMissing = errors.New("peer access hash is not available for this account")

type PeerHashes interface {
	GetUserAccessHash(context.Context, int64, int64) (int64, bool, error)
	GetChannelAccessHash(context.Context, int64, int64) (int64, bool, error)
}

// ResolvePeer uses full access hashes saved for the authenticated account.
// A cached hash is not permission to send; authorization remains a separate
// command gate. Missing/stale peers require an explicit network resolver.
func ResolvePeer(ctx context.Context, account int64, hashes PeerHashes, peer tg.PeerClass) (tg.InputPeerClass, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if account <= 0 {
		return nil, errors.New("authenticated account ID required")
	}
	switch p := peer.(type) {
	case *tg.PeerChat:
		if p != nil && p.ChatID > 0 {
			return &tg.InputPeerChat{ChatID: p.ChatID}, nil
		}
	case *tg.PeerUser:
		if p == nil || p.UserID <= 0 {
			break
		}
		if p.UserID == account {
			return &tg.InputPeerSelf{}, nil
		}
		if hashes == nil {
			return nil, ErrPeerHashMissing
		}
		hash, found, err := hashes.GetUserAccessHash(ctx, account, p.UserID)
		if err != nil {
			return nil, err
		}
		if !found || hash == 0 {
			return nil, ErrPeerHashMissing
		}
		return &tg.InputPeerUser{UserID: p.UserID, AccessHash: hash}, nil
	case *tg.PeerChannel:
		if p == nil || p.ChannelID <= 0 {
			break
		}
		if hashes == nil {
			return nil, ErrPeerHashMissing
		}
		hash, found, err := hashes.GetChannelAccessHash(ctx, account, p.ChannelID)
		if err != nil {
			return nil, err
		}
		if !found {
			return nil, ErrPeerHashMissing
		}
		return &tg.InputPeerChannel{ChannelID: p.ChannelID, AccessHash: hash}, nil
	}
	return nil, errors.New("invalid peer identity")
}
