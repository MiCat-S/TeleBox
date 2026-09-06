// Package aihttp provides bounded HTTP transport for candidate AI adapters.
package aihttp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

var ErrTransport = errors.New("AI HTTP transport failed")
var ErrResponseLimit = errors.New("AI HTTP response exceeds configured limit")

type StatusError struct{ Code int }

func (e *StatusError) Error() string { return fmt.Sprintf("AI HTTP status %d", e.Code) }

type Client struct {
	http     *http.Client
	timeout  time.Duration
	maxBytes int64
}

// New accepts an application-owned transport (including its proxy policy).
// Redirects are rejected to avoid forwarding provider credentials or prompts
// to an unconfigured destination. This policy needs migration validation.
func New(transport http.RoundTripper, timeout time.Duration, maxBytes int64) (*Client, error) {
	if transport == nil || timeout <= 0 || maxBytes <= 0 || maxBytes == 1<<63-1 {
		return nil, errors.New("transport, positive timeout and bounded response size required")
	}
	return &Client{http: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, timeout: timeout, maxBytes: maxBytes}, nil
}

// PostJSON deliberately omits endpoint, headers and response body from errors.
// Cancellation is preserved for lifecycle management. SSE can be collected by
// this operation and decoded afterward; it does not deliver incremental tokens.
func (c *Client) PostJSON(ctx context.Context, endpoint string, headers http.Header, body any) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, errors.New("AI request JSON encoding failed")
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return nil, ErrTransport
	}
	req.Header = headers.Clone()
	if req.Header == nil {
		req.Header = make(http.Header)
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, ErrTransport
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &StatusError{Code: response.StatusCode}
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, c.maxBytes+1))
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil {
		return nil, ErrTransport
	}
	if int64(len(data)) > c.maxBytes {
		return nil, ErrResponseLimit
	}
	return data, nil
}
