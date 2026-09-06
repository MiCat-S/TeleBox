package probe

import (
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/robfig/cron/v3"
	"telebox.local/rewrite-probe/schedule"
)

// Passing this audit means known differences are reproduced, not compatibility.
func TestCronCompatibilityAudit(t *testing.T) {
	raw, err := exec.Command("node", "../cron-fixtures.cjs").Output()
	if err != nil {
		t.Fatal(err)
	}
	var rows []struct {
		Name, Expression, Zone, Start string
		Dates                         []string
		Error                         *string
	}
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatal(err)
	}
	parser := cron.NewParser(cron.SecondOptional | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor)
	differences := map[string]struct {
		index               int
		baseline, candidate string
	}{
		"full-week-range": {0, "2026-09-15T00:00:00Z", "2026-09-02T00:00:00Z"},
		"full-dom-range":  {0, "2026-09-07T00:00:00Z", "2026-09-02T00:00:00Z"},
		"spring-gap":      {0, "2026-03-08T07:00:00Z", "2026-03-09T06:30:00Z"},
		"fall-repeat":     {1, "2026-11-02T06:30:00Z", "2026-11-01T06:30:00Z"},
	}
	for _, row := range rows {
		t.Run(row.Name, func(t *testing.T) {
			schedule, err := parser.Parse("CRON_TZ=" + row.Zone + " " + row.Expression)
			if strings.HasPrefix(row.Name, "sunday-") {
				if row.Error != nil || err == nil || !strings.Contains(err.Error(), "above maximum (6)") {
					t.Fatalf("Sunday compatibility changed: baseline=%v candidate=%v", row.Error, err)
				}
				t.Log("INCOMPATIBLE: baseline accepts Sunday 7; candidate rejects it")
				return
			}
			if row.Error != nil {
				if err == nil {
					t.Fatalf("candidate accepts baseline-invalid expression: %s", *row.Error)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			cursor, err := time.Parse(time.RFC3339, row.Start)
			if err != nil {
				t.Fatal(err)
			}
			difference, known := differences[row.Name]
			for i, iso := range row.Dates {
				want, err := time.Parse(time.RFC3339Nano, iso)
				if err != nil {
					t.Fatal(err)
				}
				cursor = schedule.Next(cursor)
				if known && i == difference.index {
					if want.UTC().Format(time.RFC3339) != difference.baseline || cursor.UTC().Format(time.RFC3339) != difference.candidate {
						t.Fatalf("known difference changed: baseline=%s candidate=%s", want, cursor)
					}
					t.Logf("INCOMPATIBLE: baseline=%s candidate=%s", want, cursor)
					return
				}
				if !cursor.Equal(want) {
					t.Fatalf("baseline=%s candidate=%s", want, cursor)
				}
			}
		})
	}
}

func TestCompiledCronFieldsMatchBaseline(t *testing.T) {
	raw, err := exec.Command("node", "../cron-fixtures.cjs").Output()
	if err != nil {
		t.Fatal(err)
	}
	var rows []struct {
		Name, Start string
		Dates       []string
		Error       *string
		Compiled    *schedule.Compiled
	}
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		t.Run(row.Name, func(t *testing.T) {
			if row.Error != nil {
				if row.Compiled != nil {
					t.Fatal("invalid expression compiled")
				}
				return
			}
			if row.Compiled == nil {
				t.Fatal("missing compiled schedule")
			}
			spec, err := row.Compiled.ParseFields()
			if err != nil {
				t.Fatal(err)
			}
			cursor, err := time.Parse(time.RFC3339, row.Start)
			if err != nil {
				t.Fatal(err)
			}
			mismatch := false
			for _, iso := range row.Dates {
				want, err := time.Parse(time.RFC3339Nano, iso)
				if err != nil {
					t.Fatal(err)
				}
				cursor = spec.Next(cursor)
				if !cursor.Equal(want) {
					mismatch = true
				}
			}
			if row.Name == "spring-gap" || row.Name == "fall-repeat" {
				if !mismatch {
					t.Fatal("known DST difference changed; review adapter")
				}
				t.Log("UNRESOLVED: native DST semantics still differ")
			} else if mismatch {
				t.Fatal("compiled field schedule differs from baseline")
			}
		})
	}
}

func TestWallCronCompatibilityAudit(t *testing.T) {
	raw, err := exec.Command("node", "../cron-fixtures.cjs", "--wall").Output()
	if err != nil {
		t.Fatal(err)
	}
	var rows []struct {
		Name, Start string
		Dates       []string
		Error       *string
		Compiled    *schedule.Compiled
	}
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		t.Run(row.Name, func(t *testing.T) {
			if row.Error != nil {
				if row.Name != "bad-step" && row.Name != "bad-hour" {
					t.Fatalf("unexpected baseline error: %s", *row.Error)
				}
				return
			}
			if row.Compiled == nil {
				t.Fatal("missing compiled record")
			}
			spec, err := row.Compiled.ParseWall()
			if err != nil {
				t.Fatal(err)
			}
			cursor, err := time.Parse(time.RFC3339, row.Start)
			if err != nil {
				t.Fatal(err)
			}
			for _, iso := range row.Dates {
				want, err := time.Parse(time.RFC3339Nano, iso)
				if err != nil {
					t.Fatal(err)
				}
				cursor, err = spec.Next(cursor)
				if err != nil {
					t.Fatal(err)
				}
				if !cursor.Equal(want) {
					known := map[string][2]string{
						"lord-howe-gap":    {"2026-10-03T15:15:00Z", "2026-10-03T15:45:00Z"},
						"lord-howe-repeat": {"2026-04-04T14:15:00Z", "2026-04-04T14:45:00Z"},
					}
					if times, ok := known[row.Name]; ok && want.UTC().Format(time.RFC3339) == times[0] && cursor.UTC().Format(time.RFC3339) == times[1] {
						t.Logf("UNRESOLVED half-hour transition: baseline=%s candidate=%s", want, cursor)
						return
					}
					t.Fatalf("baseline=%s candidate=%s", want, cursor)
				}
			}
		})
	}
}
