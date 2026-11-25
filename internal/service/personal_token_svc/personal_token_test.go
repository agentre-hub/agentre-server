package personal_token_svc

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/cago-frame/cago/pkg/utils/httputils"
	"github.com/go-sql-driver/mysql"
	. "github.com/smartystreets/goconvey/convey"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/personal_token_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/hashutil"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo/mock_device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/personal_token_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/personal_token_repo/mock_personal_token_repo"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
)

const nowMs = int64(1_800_000_000_000)

var (
	cliCaller     = Caller{AccountID: 7, DeviceID: 3, Kind: device_entity.KindCLI}
	sessionCaller = Caller{AccountID: 7}
	thirtyDaysMs  = int64(30 * 24 * time.Hour / time.Millisecond)
)

func setup(t *testing.T) (*personalTokenSvc, *mock_personal_token_repo.MockPersonalTokenRepo, *mock_device_repo.MockDeviceRepo) {
	ctrl := gomock.NewController(t)
	tokens := mock_personal_token_repo.NewMockPersonalTokenRepo(ctrl)
	devices := mock_device_repo.NewMockDeviceRepo(ctrl)
	personal_token_repo.RegisterPersonalToken(tokens)
	device_repo.RegisterDevice(devices)
	t.Cleanup(func() { personal_token_repo.RegisterPersonalToken(nil); device_repo.RegisterDevice(nil) })
	svc := New()
	svc.now = func() int64 { return nowMs }
	return svc, tokens, devices
}

func httpError(err error) (int, int) {
	var he *httputils.Error
	So(errors.As(err, &he), ShouldBeTrue)
	return he.Status, he.Code
}

func cliDevice() []*device_entity.Device {
	return []*device_entity.Device{{ID: 3, UserID: 7, Name: "laptop", Kind: device_entity.KindCLI}}
}

func TestCreate(t *testing.T) {
	ctx := context.Background()
	Convey("Create", t, func() {
		svc, tokens, devices := setup(t)

		Convey("when a cli device creates a token, then the plaintext is returned once and only its hash is stored", func() {
			var stored *personal_token_entity.PersonalToken
			tokens.EXPECT().FindByName(gomock.Any(), int64(7), "ci").Return(nil, nil)
			tokens.EXPECT().Create(gomock.Any(), gomock.Any()).DoAndReturn(
				func(_ context.Context, e *personal_token_entity.PersonalToken) error {
					stored = e
					e.ID = 11
					return nil
				})
			devices.EXPECT().ListByUser(gomock.Any(), int64(7)).Return(cliDevice(), nil)

			out, err := svc.Create(ctx, cliCaller, CreateInput{Name: " ci ", Scopes: []string{"chat", "read"}})
			So(err, ShouldBeNil)
			So(out.Token, ShouldStartWith, TokenPrefix)
			So(len(out.Token), ShouldBeGreaterThan, len(TokenPrefix)+40)
			So(stored.TokenHash, ShouldEqual, hashutil.SHA256Hex(out.Token))
			So(stored.TokenHash, ShouldNotContainSubstring, strings.TrimPrefix(out.Token, TokenPrefix))
			So(stored.UserID, ShouldEqual, 7)
			So(stored.Name, ShouldEqual, "ci")
			So(stored.Scopes, ShouldEqual, "read,chat")
			So(stored.PeerFingerprint, ShouldNotBeEmpty)
			So(stored.CreatedByDeviceID, ShouldEqual, 3)
			So(out.Name, ShouldEqual, "ci")
			So(out.Scopes, ShouldResemble, []string{"read", "chat"})
			So(out.CreatedByDeviceName, ShouldEqual, "laptop")

			Convey("and with no lifetime asked for, it expires in 30 days", func() {
				So(stored.LifetimeMs, ShouldEqual, thirtyDaysMs)
				So(stored.ExpiresAt, ShouldEqual, nowMs+thirtyDaysMs)
				So(out.ExpiresAt, ShouldEqual, nowMs+thirtyDaysMs)
			})
		})

		Convey("when two tokens are created, then each gets its own secret and its own peer fingerprint", func() {
			var stored []*personal_token_entity.PersonalToken
			tokens.EXPECT().FindByName(gomock.Any(), int64(7), gomock.Any()).Return(nil, nil).Times(2)
			tokens.EXPECT().Create(gomock.Any(), gomock.Any()).DoAndReturn(
				func(_ context.Context, e *personal_token_entity.PersonalToken) error {
					stored = append(stored, e)
					return nil
				}).Times(2)
			first, err := svc.Create(ctx, sessionCaller, CreateInput{Name: "a", Scopes: []string{"read"}})
			So(err, ShouldBeNil)
			second, err := svc.Create(ctx, sessionCaller, CreateInput{Name: "b", Scopes: []string{"read"}})
			So(err, ShouldBeNil)
			So(first.Token, ShouldNotEqual, second.Token)
			So(stored[0].PeerFingerprint, ShouldNotEqual, stored[1].PeerFingerprint)
			So(stored[0].CreatedByDeviceID, ShouldEqual, 0)
		})

		Convey("when never is asked for, then the token has no expiry", func() {
			var stored *personal_token_entity.PersonalToken
			tokens.EXPECT().FindByName(gomock.Any(), int64(7), "forever").Return(nil, nil)
			tokens.EXPECT().Create(gomock.Any(), gomock.Any()).DoAndReturn(
				func(_ context.Context, e *personal_token_entity.PersonalToken) error { stored = e; return nil })
			out, err := svc.Create(ctx, sessionCaller, CreateInput{
				Name: "forever", Scopes: []string{"read"}, Lifetime: Lifetime{Never: true},
			})
			So(err, ShouldBeNil)
			So(stored.ExpiresAt, ShouldEqual, 0)
			So(stored.LifetimeMs, ShouldEqual, 0)
			So(out.ExpiresAt, ShouldEqual, 0)
		})

		Convey("when an explicit lifetime is asked for, then it expires that long from now", func() {
			var stored *personal_token_entity.PersonalToken
			tokens.EXPECT().FindByName(gomock.Any(), int64(7), "short").Return(nil, nil)
			tokens.EXPECT().Create(gomock.Any(), gomock.Any()).DoAndReturn(
				func(_ context.Context, e *personal_token_entity.PersonalToken) error { stored = e; return nil })
			_, err := svc.Create(ctx, sessionCaller, CreateInput{
				Name: "short", Scopes: []string{"read"}, Lifetime: Lifetime{Seconds: 3600},
			})
			So(err, ShouldBeNil)
			So(stored.ExpiresAt, ShouldEqual, nowMs+3_600_000)
		})

		Convey("when the name is already taken in the account, then it is rejected with 409 and nothing is written", func() {
			tokens.EXPECT().FindByName(gomock.Any(), int64(7), "ci").
				Return(&personal_token_entity.PersonalToken{ID: 1, UserID: 7, Name: "ci"}, nil)
			_, err := svc.Create(ctx, cliCaller, CreateInput{Name: "ci", Scopes: []string{"read"}})
			status, _ := httpError(err)
			So(status, ShouldEqual, http.StatusConflict)
		})

		Convey("when a concurrent create wins the unique key, then it is still a 409", func() {
			tokens.EXPECT().FindByName(gomock.Any(), int64(7), "ci").Return(nil, nil)
			tokens.EXPECT().Create(gomock.Any(), gomock.Any()).Return(&mysql.MySQLError{
				Number: 1062, Message: "Duplicate entry '7-ci' for key 'personal_tokens.uk_personal_tokens_user_name'",
			})
			_, err := svc.Create(ctx, cliCaller, CreateInput{Name: "ci", Scopes: []string{"read"}})
			status, _ := httpError(err)
			So(status, ShouldEqual, http.StatusConflict)
		})

		Convey("when the scopes, name or lifetime are invalid, then it is a 400 and nothing is written", func() {
			for _, in := range []CreateInput{
				{Name: "ci", Scopes: []string{"admin"}},
				{Name: "ci"},
				{Name: "a/b", Scopes: []string{"read"}},
				{Name: "ci", Scopes: []string{"read"}, Lifetime: Lifetime{Seconds: 60, Never: true}},
				{Name: "ci", Scopes: []string{"read"}, Lifetime: Lifetime{Seconds: -1}},
			} {
				_, err := svc.Create(ctx, cliCaller, in)
				status, businessCode := httpError(err)
				So(status, ShouldEqual, http.StatusBadRequest)
				So(businessCode, ShouldEqual, code.InvalidParameter)
			}
		})

		Convey("when the caller is a personal token or a non-cli device, then it is forbidden and nothing is touched", func() {
			for _, caller := range []Caller{
				{AccountID: 7, Kind: device_svc.KindPersonalToken},
				{AccountID: 7, DeviceID: 9, Kind: device_entity.KindDesktop},
				{AccountID: 7, DeviceID: 9, Kind: device_entity.KindAgentred},
			} {
				_, err := svc.Create(ctx, caller, CreateInput{Name: "ci", Scopes: []string{"read"}})
				status, _ := httpError(err)
				So(status, ShouldEqual, http.StatusForbidden)
			}
		})
	})
}

func TestRotate(t *testing.T) {
	ctx := context.Background()
	existing := func(lifetimeMs int64) *personal_token_entity.PersonalToken {
		return &personal_token_entity.PersonalToken{
			ID: 11, UserID: 7, Name: "ci", TokenHash: "old-digest", Scopes: "read,approve",
			PeerFingerprint: "pat:stable", LifetimeMs: lifetimeMs, ExpiresAt: 1000, Createtime: 500,
		}
	}
	Convey("Rotate", t, func() {
		svc, tokens, devices := setup(t)
		devices.EXPECT().ListByUser(gomock.Any(), gomock.Any()).Return(nil, nil).AnyTimes()

		Convey("when a token is rotated, then it gets a new secret and keeps its name, scopes and peer fingerprint", func() {
			var updated *personal_token_entity.PersonalToken
			tokens.EXPECT().FindByName(gomock.Any(), int64(7), "ci").Return(existing(thirtyDaysMs), nil)
			tokens.EXPECT().UpdateSecret(gomock.Any(), gomock.Any(), "old-digest").DoAndReturn(
				func(_ context.Context, e *personal_token_entity.PersonalToken, _ string) (int64, error) {
					updated = e
					return 1, nil
				})

			out, err := svc.Rotate(ctx, cliCaller, RotateInput{Name: "ci"})
			So(err, ShouldBeNil)
			So(out.Token, ShouldStartWith, TokenPrefix)
			So(updated.ID, ShouldEqual, 11)
			So(updated.TokenHash, ShouldEqual, hashutil.SHA256Hex(out.Token))
			So(updated.TokenHash, ShouldNotEqual, "old-digest")
			So(updated.PeerFingerprint, ShouldEqual, "pat:stable")
			So(updated.RotatedAt, ShouldEqual, nowMs)
			So(out.Name, ShouldEqual, "ci")
			So(out.Scopes, ShouldResemble, []string{"read", "approve"})
			So(out.RotatedAt, ShouldEqual, nowMs)

			Convey("and without a new lifetime, the old rule restarts from now", func() {
				So(updated.ExpiresAt, ShouldEqual, nowMs+thirtyDaysMs)
			})
		})

		Convey("when a never-expiring token is rotated without a lifetime, then it still never expires", func() {
			var updated *personal_token_entity.PersonalToken
			tokens.EXPECT().FindByName(gomock.Any(), int64(7), "ci").Return(existing(0), nil)
			tokens.EXPECT().UpdateSecret(gomock.Any(), gomock.Any(), "old-digest").DoAndReturn(
				func(_ context.Context, e *personal_token_entity.PersonalToken, _ string) (int64, error) {
					updated = e
					return 1, nil
				})
			_, err := svc.Rotate(ctx, cliCaller, RotateInput{Name: "ci"})
			So(err, ShouldBeNil)
			So(updated.ExpiresAt, ShouldEqual, 0)
		})

		Convey("when a new lifetime is given, then it replaces the old rule", func() {
			var updated *personal_token_entity.PersonalToken
			tokens.EXPECT().FindByName(gomock.Any(), int64(7), "ci").Return(existing(0), nil)
			tokens.EXPECT().UpdateSecret(gomock.Any(), gomock.Any(), "old-digest").DoAndReturn(
				func(_ context.Context, e *personal_token_entity.PersonalToken, _ string) (int64, error) {
					updated = e
					return 1, nil
				})
			_, err := svc.Rotate(ctx, cliCaller, RotateInput{Name: "ci", Lifetime: Lifetime{Seconds: 60}})
			So(err, ShouldBeNil)
			So(updated.LifetimeMs, ShouldEqual, 60_000)
			So(updated.ExpiresAt, ShouldEqual, nowMs+60_000)
		})

		Convey("when the old secret is presented after a rotation, then it no longer resolves", func() {
			tokens.EXPECT().FindByHash(gomock.Any(), hashutil.SHA256Hex(TokenPrefix+"old")).Return(nil, nil)
			_, err := svc.ResolveBearer(ctx, TokenPrefix+"old")
			So(err, ShouldEqual, device_svc.ErrBearerInvalid)
		})

		Convey("when another rotation replaced the secret between the read and the write, then it is a 409 and no secret is handed out", func() {
			rotatedMeanwhile := existing(thirtyDaysMs)
			rotatedMeanwhile.TokenHash = "someone-elses-digest"
			gomock.InOrder(
				tokens.EXPECT().FindByName(gomock.Any(), int64(7), "ci").Return(existing(thirtyDaysMs), nil),
				tokens.EXPECT().UpdateSecret(gomock.Any(), gomock.Any(), "old-digest").Return(int64(0), nil),
				tokens.EXPECT().FindByName(gomock.Any(), int64(7), "ci").Return(rotatedMeanwhile, nil),
			)
			out, err := svc.Rotate(ctx, cliCaller, RotateInput{Name: "ci"})
			So(out, ShouldBeNil)
			status, _ := httpError(err)
			So(status, ShouldEqual, http.StatusConflict)
		})

		Convey("when the token was deleted between the read and the write, then it is a 404", func() {
			gomock.InOrder(
				tokens.EXPECT().FindByName(gomock.Any(), int64(7), "ci").Return(existing(thirtyDaysMs), nil),
				tokens.EXPECT().UpdateSecret(gomock.Any(), gomock.Any(), "old-digest").Return(int64(0), nil),
				tokens.EXPECT().FindByName(gomock.Any(), int64(7), "ci").Return(nil, nil),
			)
			_, err := svc.Rotate(ctx, cliCaller, RotateInput{Name: "ci"})
			status, _ := httpError(err)
			So(status, ShouldEqual, http.StatusNotFound)
		})

		Convey("when the name is unknown, then it is a 404", func() {
			tokens.EXPECT().FindByName(gomock.Any(), int64(7), "ci").Return(nil, nil)
			_, err := svc.Rotate(ctx, cliCaller, RotateInput{Name: "ci"})
			status, _ := httpError(err)
			So(status, ShouldEqual, http.StatusNotFound)
		})

		Convey("when the caller is a personal token, then it is forbidden", func() {
			_, err := svc.Rotate(ctx, Caller{AccountID: 7, Kind: device_svc.KindPersonalToken}, RotateInput{Name: "ci"})
			status, _ := httpError(err)
			So(status, ShouldEqual, http.StatusForbidden)
		})
	})
}

func TestListAndDelete(t *testing.T) {
	ctx := context.Background()
	Convey("List and Delete", t, func() {
		svc, tokens, devices := setup(t)

		Convey("when tokens are listed, then every fact is shown but no secret", func() {
			tokens.EXPECT().ListByUser(gomock.Any(), int64(7)).Return([]*personal_token_entity.PersonalToken{
				{ID: 1, UserID: 7, Name: "ci", TokenHash: "digest", Scopes: "read", CreatedByDeviceID: 3,
					ExpiresAt: 9000, LastUsedAt: 8000, RotatedAt: 7000, Createtime: 6000},
				{ID: 2, UserID: 7, Name: "forever", TokenHash: "digest-2", Scopes: "chat,approve"},
			}, nil)
			devices.EXPECT().ListByUser(gomock.Any(), int64(7)).Return(cliDevice(), nil)

			views, err := svc.List(ctx, cliCaller)
			So(err, ShouldBeNil)
			So(views, ShouldResemble, []TokenView{
				{Name: "ci", Scopes: []string{"read"}, Createtime: 6000, ExpiresAt: 9000, LastUsedAt: 8000,
					RotatedAt: 7000, CreatedByDeviceID: 3, CreatedByDeviceName: "laptop"},
				{Name: "forever", Scopes: []string{"chat", "approve"}},
			})
		})

		Convey("when a token is deleted, then its row is removed", func() {
			tokens.EXPECT().DeleteByName(gomock.Any(), int64(7), "ci").Return(int64(1), nil)
			So(svc.Delete(ctx, cliCaller, "ci"), ShouldBeNil)
		})

		Convey("when the deleted name is unknown, then it is a 404", func() {
			tokens.EXPECT().DeleteByName(gomock.Any(), int64(7), "ci").Return(int64(0), nil)
			status, _ := httpError(svc.Delete(ctx, cliCaller, "ci"))
			So(status, ShouldEqual, http.StatusNotFound)
		})

		Convey("when a personal token tries to list or delete, then it is forbidden", func() {
			pat := Caller{AccountID: 7, Kind: device_svc.KindPersonalToken}
			_, err := svc.List(ctx, pat)
			status, _ := httpError(err)
			So(status, ShouldEqual, http.StatusForbidden)
			status, _ = httpError(svc.Delete(ctx, pat, "ci"))
			So(status, ShouldEqual, http.StatusForbidden)
		})
	})
}

func TestResolveBearer(t *testing.T) {
	ctx := context.Background()
	const token = TokenPrefix + "secret"
	row := func() *personal_token_entity.PersonalToken {
		return &personal_token_entity.PersonalToken{
			ID: 11, UserID: 7, Name: "ci", TokenHash: hashutil.SHA256Hex(token), Scopes: "read,chat",
			PeerFingerprint: "pat:stable", ExpiresAt: nowMs + 60_000, LastUsedAt: nowMs - 1000,
		}
	}
	Convey("ResolveBearer", t, func() {
		svc, tokens, _ := setup(t)

		Convey("when a live token is presented, then it resolves to a personal_token principal with its scopes and own fingerprint", func() {
			tokens.EXPECT().FindByHash(gomock.Any(), hashutil.SHA256Hex(token)).Return(row(), nil)
			p, err := svc.ResolveBearer(ctx, token)
			So(err, ShouldBeNil)
			So(*p, ShouldResemble, device_svc.Principal{
				AccountID: 7, DeviceID: 0, Kind: device_svc.KindPersonalToken, PeerFingerprint: "pat:stable",
				ExpiresAt: nowMs + 60_000, Handle: "pat:11", Scopes: []string{"read", "chat"}, TokenName: "ci",
			})
			So(IsHandle(p.Handle), ShouldBeTrue)
		})

		Convey("when the token was last used a while ago, then the use is recorded", func() {
			stale := row()
			stale.LastUsedAt = nowMs - 2*60_000
			tokens.EXPECT().FindByHash(gomock.Any(), gomock.Any()).Return(stale, nil)
			tokens.EXPECT().TouchLastUsed(gomock.Any(), int64(11), nowMs).Return(nil)
			_, err := svc.ResolveBearer(ctx, token)
			So(err, ShouldBeNil)
		})

		Convey("when recording the use fails, then the token still resolves", func() {
			stale := row()
			stale.LastUsedAt = 0
			tokens.EXPECT().FindByHash(gomock.Any(), gomock.Any()).Return(stale, nil)
			tokens.EXPECT().TouchLastUsed(gomock.Any(), int64(11), nowMs).Return(errors.New("db down"))
			_, err := svc.ResolveBearer(ctx, token)
			So(err, ShouldBeNil)
		})

		Convey("when the token is expired, then it is invalid", func() {
			expired := row()
			expired.ExpiresAt = nowMs
			tokens.EXPECT().FindByHash(gomock.Any(), gomock.Any()).Return(expired, nil)
			_, err := svc.ResolveBearer(ctx, token)
			So(err, ShouldEqual, device_svc.ErrBearerInvalid)
		})

		Convey("when the token was deleted (revoked), then it is invalid", func() {
			tokens.EXPECT().FindByHash(gomock.Any(), gomock.Any()).Return(nil, nil)
			_, err := svc.ResolveBearer(ctx, token)
			So(err, ShouldEqual, device_svc.ErrBearerInvalid)
		})

		Convey("when the string is not a personal token at all, then it is invalid without a database lookup", func() {
			for _, other := range []string{"", "device-access-token", "agr_pat"} {
				_, err := svc.ResolveBearer(ctx, other)
				So(err, ShouldEqual, device_svc.ErrBearerInvalid)
			}
		})

		Convey("when the lookup fails, then the error is passed up, not disguised as invalid", func() {
			tokens.EXPECT().FindByHash(gomock.Any(), gomock.Any()).Return(nil, errors.New("db down"))
			_, err := svc.ResolveBearer(ctx, token)
			So(err, ShouldNotBeNil)
			So(errors.Is(err, device_svc.ErrBearerInvalid), ShouldBeFalse)
		})
	})
}

func TestWatchRelayCredential(t *testing.T) {
	ctx := context.Background()
	live := &personal_token_entity.PersonalToken{ID: 11, UserID: 7, TokenHash: "digest-1"}
	Convey("WatchRelayCredential", t, func() {
		svc, tokens, _ := setup(t)

		Convey("when the token behind the connection is unchanged, then the connection stays", func() {
			tokens.EXPECT().Find(gomock.Any(), int64(11)).Return(live, nil).Times(2)
			watch := svc.WatchRelayCredential(ctx, 7, "pat:11")
			So(watch(ctx), ShouldBeFalse)
		})

		Convey("when the token is deleted, rotated or expired, then the connection is revoked", func() {
			rotated := *live
			rotated.TokenHash = "digest-2"
			expired := *live
			expired.ExpiresAt = nowMs
			tokens.EXPECT().Find(gomock.Any(), int64(11)).Return(live, nil)
			watch := svc.WatchRelayCredential(ctx, 7, "pat:11")
			for _, now := range []*personal_token_entity.PersonalToken{nil, &rotated, &expired} {
				tokens.EXPECT().Find(gomock.Any(), int64(11)).Return(now, nil)
				So(watch(ctx), ShouldBeTrue)
			}
		})

		Convey("when the token belongs to another account or the handle is unknown, then the connection is revoked", func() {
			tokens.EXPECT().Find(gomock.Any(), int64(11)).Return(live, nil)
			So(svc.WatchRelayCredential(ctx, 8, "pat:11")(ctx), ShouldBeTrue)
			So(svc.WatchRelayCredential(ctx, 7, "pat:x")(ctx), ShouldBeTrue)
		})

		Convey("when the store cannot answer, then the connection is not cut", func() {
			tokens.EXPECT().Find(gomock.Any(), int64(11)).Return(live, nil)
			watch := svc.WatchRelayCredential(ctx, 7, "pat:11")
			tokens.EXPECT().Find(gomock.Any(), int64(11)).Return(nil, errors.New("db down"))
			So(watch(ctx), ShouldBeFalse)
		})
	})
}

func TestSelf(t *testing.T) {
	ctx := context.Background()
	patCaller := Caller{AccountID: 7, Kind: device_svc.KindPersonalToken, Handle: "pat:11"}
	Convey("Self", t, func() {
		svc, tokens, devices := setup(t)

		Convey("when a personal token asks about itself, then its own facts are returned without a secret", func() {
			tokens.EXPECT().Find(gomock.Any(), int64(11)).Return(&personal_token_entity.PersonalToken{
				ID: 11, UserID: 7, Name: "ci", TokenHash: "digest", Scopes: "read,chat", ExpiresAt: 9000,
				CreatedByDeviceID: 3, PeerFingerprint: "pat:fp-11",
			}, nil)
			devices.EXPECT().ListByUser(gomock.Any(), int64(7)).Return(cliDevice(), nil)
			view, err := svc.Self(ctx, patCaller)
			So(err, ShouldBeNil)
			// 对端指纹只有「查自己」交出:agrctl 据它认出自己发起的会话(list sessions --mine),
			// 不必等有设备在线再从 relay 握手里读。
			So(view, ShouldResemble, TokenView{Name: "ci", Scopes: []string{"read", "chat"}, ExpiresAt: 9000,
				CreatedByDeviceID: 3, CreatedByDeviceName: "laptop", PeerFingerprint: "pat:fp-11"})
		})

		Convey("when the caller is a browser session or a device, then it is forbidden and nothing is read", func() {
			for _, who := range []Caller{sessionCaller, cliCaller} {
				_, err := svc.Self(ctx, who)
				status, _ := httpError(err)
				So(status, ShouldEqual, http.StatusForbidden)
			}
		})

		Convey("when the token row is gone or belongs to another account, then it is a 404", func() {
			tokens.EXPECT().Find(gomock.Any(), int64(11)).Return(nil, nil)
			_, err := svc.Self(ctx, patCaller)
			status, _ := httpError(err)
			So(status, ShouldEqual, http.StatusNotFound)

			tokens.EXPECT().Find(gomock.Any(), int64(11)).Return(&personal_token_entity.PersonalToken{ID: 11, UserID: 8, Name: "x"}, nil)
			_, err = svc.Self(ctx, patCaller)
			status, _ = httpError(err)
			So(status, ShouldEqual, http.StatusNotFound)
		})
	})
}
