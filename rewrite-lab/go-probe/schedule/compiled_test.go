package schedule

import "testing"

func TestCompiledValidation(t *testing.T) {
	valid := Compiled{Format: 1, Parser: "node-cron/4.3.3", Expression: "0 8 * * *", Zone: "Asia/Shanghai", Canonical: "0 0 8 * * *"}
	if _, err := valid.ParseFields(); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(*Compiled){
		"version":       func(c *Compiled) { c.Format = 2 },
		"parser":        func(c *Compiled) { c.Parser = "" },
		"source":        func(c *Compiled) { c.Expression = "" },
		"zone":          func(c *Compiled) { c.Zone = "Invalid/Zone" },
		"implicit-zone": func(c *Compiled) { c.Zone = "" },
		"fields":        func(c *Compiled) { c.Canonical = "0 8 * * *" },
		"range":         func(c *Compiled) { c.Canonical = "0 0 0 * * 0-6" },
		"bounds":        func(c *Compiled) { c.Canonical = "0 0 24 * * *" },
	} {
		t.Run(name, func(t *testing.T) {
			c := valid
			change(&c)
			if _, err := c.ParseFields(); err == nil {
				t.Fatal("invalid record accepted")
			}
		})
	}
}
