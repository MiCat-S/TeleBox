// Package schedule contains candidate scheduling adapters, not production jobs.
package schedule

import (
	"errors"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
)

type Compiled struct {
	Format     int    `json:"format"`
	Parser     string `json:"parser"`
	Expression string `json:"expression"`
	Zone       string `json:"zone"`
	Canonical  string `json:"canonical"`
}

// ParseFields preserves resolved field sets. The returned native schedule still
// has robfig's DST semantics; callers must not treat it as fully compatible.
func (c Compiled) ParseFields() (*cron.SpecSchedule, error) {
	if c.Format != 1 || !strings.HasPrefix(c.Parser, "node-cron/") || c.Expression == "" || c.Zone == "" {
		return nil, errors.New("invalid compiled schedule metadata")
	}
	if len(strings.Fields(c.Canonical)) != 6 {
		return nil, errors.New("compiled schedule must contain six fields")
	}
	for _, r := range c.Canonical {
		if r != ' ' && r != ',' && r != '*' && (r < '0' || r > '9') {
			return nil, errors.New("compiled schedule contains unresolved syntax")
		}
	}
	loc, err := time.LoadLocation(c.Zone)
	if err != nil {
		return nil, err
	}
	parser := cron.NewParser(cron.Second | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)
	parsed, err := parser.Parse(c.Canonical)
	if err != nil {
		return nil, err
	}
	spec := parsed.(*cron.SpecSchedule)
	spec.Location = loc
	return spec, nil
}
