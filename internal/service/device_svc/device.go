// Package device_svc 编排 RFC 8628 Device Flow 与 token 生命周期。
package device_svc

import (
	"context"
	"crypto/rand"
	"encoding/base32"
	"fmt"
	"strings"
	"time"

	"agentre-hub/internal/model/entity/device_flow_entity"
	"agentre-hub/internal/pkg/usercode"
	"agentre-hub/internal/repository/device_flow_repo"
)

type DeviceSvc interface {
	Authorize(ctx context.Context, in AuthorizeInput) (*AuthorizeOutput, error)
	Pending(ctx context.Context, userCode string) (*PendingInfo, error)
	Approve(ctx context.Context, userCode string, userID int64) (kind string, err error)
	Deny(ctx context.Context, userCode string) error
	ExchangeToken(ctx context.Context, deviceCode string) (*TokenOutput, error)
	Refresh(ctx context.Context, refreshToken string) (*TokenOutput, error)
	Revoke(ctx context.Context, deviceID int64) error
}

type deviceSvc struct {
	cfg    Config
	signer Signer
}

var defaultSvc DeviceSvc

func Default() DeviceSvc     { return defaultSvc }
func SetDefault(s DeviceSvc) { defaultSvc = s }

func New(cfg Config, signer Signer) DeviceSvc           { return newDeviceSvc(cfg, signer) }
func newDeviceSvc(cfg Config, signer Signer) *deviceSvc { return &deviceSvc{cfg: cfg, signer: signer} }

func (s *deviceSvc) Authorize(ctx context.Context, in AuthorizeInput) (*AuthorizeOutput, error) {
	now := time.Now().UnixMilli()
	dc, err := randomBase32(32)
	if err != nil {
		return nil, err
	}
	uc := usercode.Generate()
	capsJSON := mustMarshalJSON(in.Capabilities)

	code := &device_flow_entity.DeviceFlowCode{
		DeviceCode:         dc,
		UserCode:           uc,
		DeviceKind:         in.DeviceKind,
		ClientFingerprint:  in.Fingerprint,
		ClientCapabilities: capsJSON,
		Platform:           in.Platform,
		Version:            in.Version,
		IntervalSeconds:    int(s.cfg.PollInterval / time.Second),
		ExpiresAt:          now + s.cfg.UserCodeTTL.Milliseconds(),
		Createtime:         now,
	}
	if err := device_flow_repo.DeviceFlow().Create(ctx, code); err != nil {
		return nil, err
	}
	base := strings.TrimRight(s.cfg.VerificationURI, "/")
	return &AuthorizeOutput{
		DeviceCode:              dc,
		UserCode:                uc,
		VerificationURI:         base,
		VerificationURIComplete: base + "?user_code=" + uc,
		Interval:                int(s.cfg.PollInterval / time.Second),
		ExpiresIn:               int(s.cfg.UserCodeTTL / time.Second),
	}, nil
}

// stubs so the interface compiles
func (s *deviceSvc) Pending(_ context.Context, _ string) (*PendingInfo, error) {
	panic("not implemented")
}
func (s *deviceSvc) Approve(_ context.Context, _ string, _ int64) (string, error) {
	panic("not implemented")
}
func (s *deviceSvc) Deny(_ context.Context, _ string) error           { panic("not implemented") }
func (s *deviceSvc) ExchangeToken(_ context.Context, _ string) (*TokenOutput, error) {
	panic("not implemented")
}
func (s *deviceSvc) Refresh(_ context.Context, _ string) (*TokenOutput, error) {
	panic("not implemented")
}
func (s *deviceSvc) Revoke(_ context.Context, _ int64) error { panic("not implemented") }

func randomBase32(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return strings.ToLower(strings.TrimRight(base32.StdEncoding.EncodeToString(buf), "=")), nil
}

func mustMarshalJSON(m map[string]bool) []byte {
	if m == nil {
		return []byte("{}")
	}
	pairs := make([]string, 0, len(m))
	for k, v := range m {
		pairs = append(pairs, fmt.Sprintf("%q:%t", k, v))
	}
	return []byte("{" + strings.Join(pairs, ",") + "}")
}
