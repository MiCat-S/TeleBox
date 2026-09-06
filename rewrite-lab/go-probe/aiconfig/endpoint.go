package aiconfig

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
)

func chatEndpoint(base, profile, key string) (string, http.Header, error) {
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
		return "", nil, errors.New("invalid AI provider URL")
	}
	headers := http.Header{"User-Agent": {legacyUserAgent}}
	path := "chat/completions"
	switch profile {
	case "openai", "openai-compatible", "moonshot":
	case "doubao":
		base = (&url.URL{Scheme: u.Scheme, Host: u.Host}).String()
		path = "api/v3/chat/completions"
	case "local-cliproxy":
		p := u.EscapedPath()
		if strings.Contains(u.Hostname(), "gateway.ai.cloudflare.com") {
			if i := strings.Index(p, "/openai"); i >= 0 {
				p = p[:i+len("/openai")]
			}
		} else {
			for _, suffix := range []string{"/chat/completions", "/completions", "/responses", "/messages", "/images/generations"} {
				if strings.HasSuffix(p, suffix) {
					p = strings.TrimSuffix(p, suffix)
					break
				}
			}
			if i := strings.Index(p, "/api/v1"); i >= 0 {
				p = p[:i+len("/api/v1")]
			} else if i := strings.Index(p, "/v1"); i >= 0 {
				p = p[:i+len("/v1")]
			} else {
				p = "/v1"
			}
		}
		decoded, err := url.PathUnescape(p)
		if err != nil {
			return "", nil, errors.New("invalid AI provider path")
		}
		u.Path, u.RawPath, u.RawQuery = decoded, p, ""
		u.ForceQuery = false
		base = u.String()
	default:
		return "", nil, errors.New("AI provider profile mapping not implemented")
	}
	if !strings.HasSuffix(base, "/") {
		base += "/"
	}
	u, err = url.Parse(base)
	if err != nil {
		return "", nil, errors.New("invalid AI provider URL")
	}
	u = u.ResolveReference(&url.URL{Path: path})
	if profile == "local-cliproxy" {
		query := u.Query()
		if !query.Has("key") {
			query.Set("key", key)
		}
		u.RawQuery = query.Encode()
	} else {
		headers.Set("Authorization", "Bearer "+key)
	}
	return u.String(), headers, nil
}
