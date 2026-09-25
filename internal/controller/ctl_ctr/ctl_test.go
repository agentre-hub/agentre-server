package ctl_ctr_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/agentre-hub/agentre/pkg/wire/agentrewire"
	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/encoding/protojson"

	"github.com/agentre-hub/agentre-server/internal/api"
	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/middleware/bearertest"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/service/ctl_svc"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
)

// fakeCtl 记下它收到的调用方与请求，回一个预设的结果。
type fakeCtl struct {
	caller  ctl_svc.Caller
	req     *agentrewire.CtlRequest
	preview bool
	resp    *agentrewire.CtlResponse
	err     error
}

func (f *fakeCtl) Handle(_ context.Context, caller ctl_svc.Caller, req *agentrewire.CtlRequest, preview bool) (*agentrewire.CtlResponse, error) {
	f.caller, f.req, f.preview = caller, req, preview
	return f.resp, f.err
}

func newEngine(t *testing.T, svc ctl_svc.CtlSvc) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{
		Cfg: &bootstrap.ServerConfig{}, Bearer: bearertest.Resolver{}, Ctl: svc,
	}).Router(context.Background(), testMux.Router))
	return testMux.IRouter.(*gin.Engine)
}

func post(engine *gin.Engine, path, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)
	return rec
}

func agentredToken() string {
	return bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 3, Kind: device_entity.KindAgentred})
}

func errorOf(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Error string `json:"error"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body), rec.Body.String())
	return body.Error
}

func TestResources_GivenDeviceBearer_ThenCallerComesFromTokenAndBodyIsProtojson(t *testing.T) {
	fake := &fakeCtl{resp: &agentrewire.CtlResponse{Result: &agentrewire.CtlResponse_Get{Get: &agentrewire.CtlGetResponse{
		Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Agent{Agent: &agentrewire.CtlAgent{Id: 20, Name: "Eva"}}},
	}}}}
	rec := post(newEngine(t, fake), "/v1/ctl/resources?preview=1", agentredToken(), `{"get":{"kind":"CTL_KIND_AGENT","id":"20"}}`)

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, ctl_svc.Caller{UserID: 7, DeviceID: 3}, fake.caller)
	assert.True(t, fake.preview)
	assert.Equal(t, int64(20), fake.req.GetGet().GetId())
	var got agentrewire.CtlResponse
	require.NoError(t, protojson.Unmarshal(rec.Body.Bytes(), &got))
	assert.Equal(t, "Eva", got.GetGet().GetResource().GetAgent().GetName())
}

// preview 只要出现就是预览（fail closed）：?preview=true 这类写法不能落成一次没经审批的
// 真写入；不带 preview 才是写入。
func TestResources_GivenAnyPreviewParam_ThenPreviewOnly(t *testing.T) {
	for _, q := range []string{"?preview=1", "?preview=true", "?preview", "?preview=yes"} {
		fake := &fakeCtl{resp: &agentrewire.CtlResponse{}}
		rec := post(newEngine(t, fake), "/v1/ctl/resources"+q, agentredToken(), `{"list":{"kind":"CTL_KIND_AGENT"}}`)
		require.Equal(t, http.StatusOK, rec.Code, q)
		assert.True(t, fake.preview, q)
	}
	fake := &fakeCtl{resp: &agentrewire.CtlResponse{}}
	rec := post(newEngine(t, fake), "/v1/ctl/resources", agentredToken(), `{"list":{"kind":"CTL_KIND_AGENT"}}`)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.False(t, fake.preview)
}

func TestResources_GivenNoDeviceBearer_ThenExecutorIsNeverReached(t *testing.T) {
	fake := &fakeCtl{}
	engine := newEngine(t, fake)
	assert.Equal(t, http.StatusUnauthorized, post(engine, "/v1/ctl/resources", "", `{}`).Code)
	assert.Equal(t, http.StatusUnauthorized, post(engine, "/v1/ctl/resources", "not-a-device-token", `{}`).Code)
	assert.Nil(t, fake.req)
}

func TestResources_GivenErrors_ThenStatusAndErrorBodyFollowTheContract(t *testing.T) {
	cases := map[string]struct {
		err    error
		status int
		msg    string
	}{
		"ctl 拒绝":  {&ctl_svc.Error{Status: http.StatusUnprocessableEntity, Msg: "nope"}, http.StatusUnprocessableEntity, "nope"},
		"服务层业务错误": {i18n.NewNotFoundError(context.Background(), code.OrgObjectNotFound), http.StatusNotFound, ""},
		"内部错误不外泄": {errors.New("dsn=secret"), http.StatusInternalServerError, "internal error"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			rec := post(newEngine(t, &fakeCtl{err: c.err}), "/v1/ctl/resources", agentredToken(), `{"list":{"kind":"CTL_KIND_AGENT"}}`)
			assert.Equal(t, c.status, rec.Code)
			msg := errorOf(t, rec)
			assert.NotEmpty(t, msg)
			if c.msg != "" {
				assert.Equal(t, c.msg, msg)
			}
		})
	}

	rec := post(newEngine(t, &fakeCtl{}), "/v1/ctl/resources", agentredToken(), `not json`)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Equal(t, "invalid request body", errorOf(t, rec))
}

func TestSend_GivenServerPath_ThenClearlyUnsupported(t *testing.T) {
	rec := post(newEngine(t, &fakeCtl{}), "/v1/ctl/send", agentredToken(), `{"agent":"Eva","text":"hi"}`)
	assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	assert.Contains(t, errorOf(t, rec), "send is not supported")
}
