package aiconfig

import (
	"encoding/json"
	"net/http"
	"os/exec"
	"testing"
)

func TestProviderProfilesAgainstActualBaseline(t *testing.T) {
	data, err := exec.Command("node", "../../provider-profile-fixtures.cjs").Output()
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct{ URL, Type, Expected string }
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) != 17 {
		t.Fatal("profile fixture coverage changed")
	}
	for _, c := range cases {
		if got := ProviderProfile(c.URL, c.Type); got != c.Expected {
			t.Fatalf("profile=%s want=%s url=%s", got, c.Expected, c.URL)
		}
	}
}

func TestInferredProfileBuildWithoutNetwork(t *testing.T) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	defer transport.CloseIdleConnections()
	for _, kind := range []string{"", "unknown", " OPENAI "} {
		d := configFor(t, "http://localhost:12345/v1", kind, false, 1)
		original := string(d.Bytes())
		if _, err := d.BuildChat(transport, 4096); err != nil {
			t.Fatal(err)
		}
		if string(d.Bytes()) != original {
			t.Fatal("inferred profile persisted into config")
		}
	}
	for _, endpoint := range []string{"https://generativelanguage.googleapis.com"} {
		if _, err := configFor(t, endpoint, "", false, 1).BuildChat(transport, 4096); err == nil {
			t.Fatal("unimplemented inferred profile remapped")
		}
	}
}
