package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/bootstrap"
)

// S6：凭据不再由签名密钥自证，公钥端点随之去除。
func TestRouter_PublicKeysEndpointIsGone(t *testing.T) {
	testMux := muxtest.NewTestMux()
	require.NoError(t, (&RouterDeps{Cfg: &bootstrap.ServerConfig{}}).Router(context.Background(), testMux.Router))
	recorder := httptest.NewRecorder()
	testMux.IRouter.(*gin.Engine).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/keys", nil))
	require.Equal(t, http.StatusNotFound, recorder.Code)
}
