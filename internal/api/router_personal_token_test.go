package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	. "github.com/smartystreets/goconvey/convey"

	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/middleware/bearertest"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/credstore"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
	"github.com/agentre-hub/agentre-server/internal/service/personal_token_svc"
	"github.com/agentre-hub/agentre-server/internal/testutils"
)

// fakePersonalTokens 记下管理调用的调用方，并且只认一枚个人 token 明文。
type fakePersonalTokens struct {
	callers []personal_token_svc.Caller
}

const fakePAT = personal_token_svc.TokenPrefix + "router-test"

func (f *fakePersonalTokens) Create(_ context.Context, c personal_token_svc.Caller, in personal_token_svc.CreateInput) (*personal_token_svc.Issued, error) {
	f.callers = append(f.callers, c)
	return &personal_token_svc.Issued{Token: fakePAT, TokenView: personal_token_svc.TokenView{Name: in.Name, Scopes: in.Scopes}}, nil
}

func (f *fakePersonalTokens) Rotate(_ context.Context, c personal_token_svc.Caller, in personal_token_svc.RotateInput) (*personal_token_svc.Issued, error) {
	f.callers = append(f.callers, c)
	return &personal_token_svc.Issued{Token: fakePAT, TokenView: personal_token_svc.TokenView{Name: in.Name}}, nil
}

func (f *fakePersonalTokens) List(_ context.Context, c personal_token_svc.Caller) ([]personal_token_svc.TokenView, error) {
	f.callers = append(f.callers, c)
	return []personal_token_svc.TokenView{{Name: "ci", Scopes: []string{"read"}, PeerFingerprint: "pat:fp-ci"}}, nil
}

func (f *fakePersonalTokens) Self(_ context.Context, c personal_token_svc.Caller) (personal_token_svc.TokenView, error) {
	f.callers = append(f.callers, c)
	return personal_token_svc.TokenView{Name: "ci", PeerFingerprint: "pat:own"}, nil
}

func (f *fakePersonalTokens) Delete(_ context.Context, c personal_token_svc.Caller, _ string) error {
	f.callers = append(f.callers, c)
	return nil
}

func (f *fakePersonalTokens) ResolveBearer(_ context.Context, token string) (*device_svc.Principal, error) {
	if token != fakePAT {
		return nil, device_svc.ErrBearerInvalid
	}
	return &device_svc.Principal{
		AccountID: 7, Kind: device_svc.KindPersonalToken, PeerFingerprint: "pat:own", Handle: "pat:11",
		Scopes: []string{"read", "chat"}, TokenName: "ci",
	}, nil
}

func (f *fakePersonalTokens) WatchRelayCredential(context.Context, int64, string) func(context.Context) bool {
	return func(context.Context) bool { return false }
}

func newPersonalTokenRouter(t *testing.T, tokens *fakePersonalTokens) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	auth_svc.SetDefault(auth_svc.New(redis.Default(), session.New(redis.Default(), 86400)))
	testMux := muxtest.NewTestMux()
	if err := (&RouterDeps{
		Cfg:            &bootstrap.ServerConfig{RateLimit: bootstrap.RLConfig{CredentialsIntrospectPerAccountPerMin: 100}},
		Bearer:         bearertest.Resolver{},
		PersonalTokens: tokens,
	}).Router(context.Background(), testMux.Router); err != nil {
		t.Fatal(err)
	}
	return testMux.IRouter.(*gin.Engine)
}

func serveWithBearer(engine *gin.Engine, method, path, bearer, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	w := httptest.NewRecorder()
	engine.ServeHTTP(w, req)
	return w
}

var personalTokenRoutes = []struct{ method, path, body string }{
	{http.MethodPost, "/v1/personal-tokens", `{"name":"ci","scopes":["read"]}`},
	{http.MethodGet, "/v1/personal-tokens", ``},
	{http.MethodPost, "/v1/personal-tokens/ci/rotate", `{}`},
	{http.MethodDelete, "/v1/personal-tokens/ci", ``},
}

func TestRouter_PersonalTokenManagement(t *testing.T) {
	Convey("personal token management routes", t, func() {
		tokens := &fakePersonalTokens{}
		engine := newPersonalTokenRouter(t, tokens)

		Convey("when a cli device calls them, then each reaches the service with the cli caller", func() {
			cli := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 3, Kind: device_entity.KindCLI, Handle: "3"})
			for _, r := range personalTokenRoutes {
				w := serveWithBearer(engine, r.method, r.path, cli, r.body)
				So(w.Code, ShouldEqual, http.StatusOK)
			}
			So(tokens.callers, ShouldHaveLength, len(personalTokenRoutes))
			for _, c := range tokens.callers {
				So(c, ShouldResemble, personal_token_svc.Caller{AccountID: 7, DeviceID: 3, Kind: device_entity.KindCLI})
			}
		})

		Convey("when the plaintext is created, then it is in the response exactly as the service issued it", func() {
			cli := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 3, Kind: device_entity.KindCLI, Handle: "3"})
			w := serveWithBearer(engine, http.MethodPost, "/v1/personal-tokens", cli, `{"name":"ci","scopes":["read"]}`)
			var envelope struct {
				Data struct {
					Token string `json:"token"`
					Item  struct {
						Name string `json:"name"`
					} `json:"item"`
				} `json:"data"`
			}
			So(json.Unmarshal(w.Body.Bytes(), &envelope), ShouldBeNil)
			So(envelope.Data.Token, ShouldEqual, fakePAT)
			So(envelope.Data.Item.Name, ShouldEqual, "ci")
		})

		Convey("when a cli device lists tokens, then each item names its peer fingerprint and the account's console peer is given", func() {
			cli := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 3, Kind: device_entity.KindCLI, Handle: "3"})
			w := serveWithBearer(engine, http.MethodGet, "/v1/personal-tokens", cli, ``)
			var envelope struct {
				Data struct {
					Tokens []struct {
						PeerFingerprint string `json:"peer_fingerprint"`
					} `json:"tokens"`
					ConsolePeerFingerprint string `json:"console_peer_fingerprint"`
				} `json:"data"`
			}
			So(json.Unmarshal(w.Body.Bytes(), &envelope), ShouldBeNil)
			So(envelope.Data.Tokens, ShouldHaveLength, 1)
			So(envelope.Data.Tokens[0].PeerFingerprint, ShouldEqual, "pat:fp-ci")
			So(envelope.Data.ConsolePeerFingerprint, ShouldEqual, credstore.AccountPeerFingerprint(7))
		})

		Convey("when a personal token asks about itself, then the console peer is given too", func() {
			w := serveWithBearer(engine, http.MethodGet, "/v1/personal-tokens/self", fakePAT, ``)
			So(w.Code, ShouldEqual, http.StatusOK)
			var envelope struct {
				Data struct {
					PeerFingerprint        string `json:"peer_fingerprint"`
					ConsolePeerFingerprint string `json:"console_peer_fingerprint"`
				} `json:"data"`
			}
			So(json.Unmarshal(w.Body.Bytes(), &envelope), ShouldBeNil)
			So(envelope.Data.PeerFingerprint, ShouldEqual, "pat:own")
			So(envelope.Data.ConsolePeerFingerprint, ShouldEqual, credstore.AccountPeerFingerprint(7))
		})

		Convey("when a personal token calls them, then it is refused and the service is never reached", func() {
			for _, r := range personalTokenRoutes {
				w := serveWithBearer(engine, r.method, r.path, fakePAT, r.body)
				So(w.Code, ShouldBeIn, []int{http.StatusUnauthorized, http.StatusForbidden})
			}
			So(tokens.callers, ShouldBeEmpty)
		})
	})
}

// 个人 token 接进了 /v1/relay/client 与核验端点共用的那个解析方：核验一枚个人 token 答出
// personal_token 形态、范围与名字。
func TestRouter_IntrospectResolvesPersonalTokens(t *testing.T) {
	Convey("when an agentred introspects a personal token, then the router's resolver knows it", t, func() {
		engine := newPersonalTokenRouter(t, &fakePersonalTokens{})
		agentred := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 5, Kind: device_entity.KindAgentred, Handle: "5"})
		w := serveWithBearer(engine, http.MethodPost, "/v1/credentials/introspect", agentred, `{"token":"`+fakePAT+`"}`)
		So(w.Code, ShouldEqual, http.StatusOK)
		var envelope struct {
			Data struct {
				Kind            string   `json:"kind"`
				PeerFingerprint string   `json:"peer_fingerprint"`
				Scopes          []string `json:"scopes"`
				TokenName       string   `json:"token_name"`
			} `json:"data"`
		}
		So(json.Unmarshal(w.Body.Bytes(), &envelope), ShouldBeNil)
		So(envelope.Data.Kind, ShouldEqual, device_svc.KindPersonalToken)
		So(envelope.Data.PeerFingerprint, ShouldEqual, "pat:own")
		So(envelope.Data.Scopes, ShouldResemble, []string{"read", "chat"})
		So(envelope.Data.TokenName, ShouldEqual, "ci")
	})
}
