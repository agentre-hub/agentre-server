package relay_ctr_test

import (
	"os"
	"testing"

	"github.com/gin-gonic/gin"
)

// TestMain 在任何用例启动服务器之前把 gin 模式定死，整包只设这一次。
//
// gin.SetMode 写的是包级全局 ginMode / modeName，gin.IsDebugging 直接读它，两边都
// 没有同步。本包每个用例都会起 httptest 服务器，上一个用例的 handler goroutine
// 还在跑的时候，下一个用例再调一次 SetMode 就是一次真实的数据竞争 —— -race 下
// 表现为「race detected during execution of test」，Linux 上约四成的概率。
// 值都一样并不能让它变得安全：竞态检测器看的是并发读写本身，不是写进去的值。
func TestMain(m *testing.M) {
	gin.SetMode(gin.TestMode)
	os.Exit(m.Run())
}
