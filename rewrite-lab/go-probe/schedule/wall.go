package schedule

import (
	"errors"
	"time"

	"github.com/robfig/cron/v3"
)

type WallSchedule struct {
	fields   *cron.SpecSchedule
	location *time.Location
}

func (c Compiled) ParseWall() (*WallSchedule, error) {
	spec, err := c.ParseFields()
	if err != nil {
		return nil, err
	}
	loc := spec.Location
	spec.Location = time.UTC
	return &WallSchedule{fields: spec, location: loc}, nil
}

func wall(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(), 0, time.UTC)
}

// Next matches local calendar fields first, then resolves the timezone. It does
// not replay the repeated wall-clock hour. Unsupported/non-forward resolutions
// are errors rather than silently scheduling in the past.
func (s *WallSchedule) Next(start time.Time) (time.Time, error) {
	target := s.fields.Next(wall(start.In(s.location)))
	if target.IsZero() {
		return time.Time{}, errors.New("no next calendar match within candidate search horizon")
	}
	guess := time.Date(target.Year(), target.Month(), target.Day(), target.Hour(), target.Minute(), target.Second(), 0, s.location)
	// Inspect all zone intervals around the date, including non-hour transitions.
	end := guess.Add(48 * time.Hour)
	offsets := make(map[int]bool)
	var transitions []time.Time
	for cursor := guess.Add(-48 * time.Hour); cursor.Before(end); {
		_, offset := cursor.Zone()
		offsets[offset] = true
		_, next := cursor.ZoneBounds()
		if next.IsZero() || !next.Before(end) {
			break
		}
		if !next.After(cursor) {
			return time.Time{}, errors.New("timezone interval did not advance")
		}
		transitions = append(transitions, next)
		cursor = next
	}
	var earliest time.Time
	for offset := range offsets {
		candidate := target.Add(-time.Duration(offset) * time.Second).In(s.location)
		if wall(candidate).Equal(target) && candidate.After(start) && (earliest.IsZero() || candidate.Before(earliest)) {
			earliest = candidate
		}
	}
	if !earliest.IsZero() {
		return earliest, nil
	}
	for _, transition := range transitions {
		_, before := transition.Add(-time.Second).Zone()
		_, after := transition.Zone()
		if after <= before {
			continue
		}
		gapStart := transition.UTC().Add(time.Duration(before) * time.Second)
		gapEnd := transition.UTC().Add(time.Duration(after) * time.Second)
		if target.Before(gapStart) || !target.Before(gapEnd) {
			continue
		}
		resolved := target.Add(-time.Duration(before) * time.Second).In(s.location)
		_, january := time.Date(resolved.Year(), 1, 1, 0, 0, 0, 0, s.location).Zone()
		// Match the baseline's January-reference correction for a nonexistent
		// local time. Southern-hemisphere gaps can retain the shifted minutes.
		if january != after {
			resolved = transition.Add(time.Duration(target.Second()) * time.Second)
		}
		if resolved.After(start) {
			return resolved, nil
		}
	}
	return time.Time{}, errors.New("local time has no supported forward resolution")
}
