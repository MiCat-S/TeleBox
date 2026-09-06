package schedule

import (
	"testing"
	"time"
)

func TestWallScheduleForwardTimes(t *testing.T) {
	c := Compiled{Format: 1, Parser: "node-cron/4.3.3", Expression: "30 1 * * *", Zone: "America/New_York", Canonical: "0 30 1 * * *"}
	s, err := c.ParseWall()
	if err != nil {
		t.Fatal(err)
	}
	for _, start := range []string{"2026-11-01T04:00:00Z", "2026-11-01T05:30:00Z", "2026-11-01T06:15:00Z", "2026-11-01T06:30:00Z"} {
		t.Run(start, func(t *testing.T) {
			t.Parallel()
			cursor, err := time.Parse(time.RFC3339, start)
			if err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 10; i++ {
				next, err := s.Next(cursor)
				if err != nil || !next.After(cursor) {
					t.Fatalf("non-forward result %s %v", next, err)
				}
				cursor = next
			}
		})
	}
}

func TestWallScheduleNoCalendarMatch(t *testing.T) {
	c := Compiled{Format: 1, Parser: "node-cron/4.3.3", Expression: "0 0 30 feb *", Zone: "UTC", Canonical: "0 0 0 30 2 *"}
	s, err := c.ParseWall()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Next(time.Date(2026, 9, 5, 0, 0, 0, 0, time.UTC)); err == nil {
		t.Fatal("missing next date hidden")
	}
}
