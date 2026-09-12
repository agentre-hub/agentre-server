package middleware

import (
	"errors"
	"net/http"

	"github.com/cago-frame/cago/pkg/utils/httputils"
	"github.com/gin-gonic/gin"

	"github.com/agentre-hub/agentre-server/internal/pkg/apierr"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/service/user_svc"
)

// accountBlocked 在凭据校验通过之后再过一次账号闸门：凭据有效不等于账号还能用。
// 被拒时它自己写完 401 响应并 Abort，返回 true 让调用方直接 return。
//
// 闸门只在完整装配（bootstrap.RegisterDefaults）之后存在。未装配的进程根本没有账号
// 库可查，判定无从做起，因此按不判定处理；生产上一定装配这件事由 bootstrap 的单测
// 钉住，而不是靠这里的运行期判断。
func accountBlocked(c *gin.Context, userID int64) bool {
	gate := user_svc.Gate()
	if gate == nil {
		return false
	}
	err := gate.Check(c.Request.Context(), userID)
	if err == nil {
		return false
	}
	// 闸门的结论一律以 401 出口，业务码沿用它给出的 UserBanned / UserNotFound：
	// 被封用户因此第一次能读到「用户已被封禁」，而不是笼统的「未授权」。
	businessCode := code.Unauthorized
	var he *httputils.Error
	if errors.As(err, &he) && he.Code != 0 {
		businessCode = he.Code
	}
	apierr.Abort(c, http.StatusUnauthorized, businessCode)
	return true
}
