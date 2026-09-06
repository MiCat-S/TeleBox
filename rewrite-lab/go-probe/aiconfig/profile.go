package aiconfig

import (
	"net/url"
	"strings"
)

// ProviderProfile resolves a legacy provider identity. Resolution does not
// imply that the corresponding protocol adapter has been implemented.
func ProviderProfile(endpoint, configured string) string {
	profile := normalized(configured, []string{"openai-compatible", "openai", "gemini", "doubao", "moonshot", "local-cliproxy"})
	if profile != "auto" {
		return profile
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme == "" {
		return "openai"
	}
	switch strings.ToLower(u.Hostname()) {
	case "generativelanguage.googleapis.com":
		return "gemini"
	case "ark.cn-beijing.volces.com":
		return "doubao"
	case "api.moonshot.cn":
		return "moonshot"
	case "127.0.0.1", "api.abjj.de":
		return "local-cliproxy"
	default:
		return "openai"
	}
}
