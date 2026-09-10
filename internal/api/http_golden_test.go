// http_golden_test.go 用**真实服务端**录 /v1/sync/* 的 HTTP 契约样本，并守它们的新鲜度。
//
// # 为什么要有它
//
// HTTP 契约的真理在本仓的 internal/api/：那里的 request / response 结构体决定了线上
// 到底发出什么 JSON。消费方是**另一个仓的 Go 代码**（桌面端 agentre 的
// internal/service/server_svc/ 手抄了一份镜像结构体），因此走不了 wire 那条
// 「生成一个 npm 包」的路。两边之间目前只有人的记性：桌面端那批 httptest 假服务端
// 里的响应体是各写各的 JSON 字面量，没有任何东西保证它们与本仓真实返回一致。
//
// 这一层先把**真理这一侧**钉死：把真实服务端跑出来的响应逐字节录成样本提交进仓，
// 再用一个总是运行的守卫盯着它们不过期。样本因此不是「某人认为服务端会返回什么」，
// 而是「服务端此刻确实返回了什么」——这个测试本身就是「服务端遵守契约」的证明。
//
// # 怎么跑的服务端
//
// 真实路由树 + 真实中间件 + 真实 controller + 真实 sync_svc，只把 repository 换成
// mockgen 生成的 mock（事务的 Begin/Commit 走 sqlmock）。也就是说：除了数据库那一层，
// 每一段决定 JSON 形状的代码都真的执行了——路由绑定、DeviceJWT 鉴权、mux 的请求绑定
// 与校验、controller 的 svc→api 结构映射、service 的判定分支、cago 的
// httputils.JSONResponse 信封、i18n 错误文案。
//
// 备选方案是把 sync_svc 也换成桩（隔壁 internal/controller/sync_ctr/sync_test.go 就是
// 那么做的）。这里刻意**不**那么做：resync-required 与 cursor-unknown 这两个错误码是
// 由 service 判出来的，桩掉 service 就等于在测试里手写一遍 i18n.NewError，样本便不再
// 证明 Push 真的会返回那个码——而那正是本文件要证明的东西。另一头的 make e2e 会连真
// MySQL/Redis，但它既不逐字节可复现，也进不了 `go test ./...`。
//
// # 三个测试各司其职
//
//   - TestHTTPGoldenSamples —— 录制自检：每条样本当场断言 HTTP 状态码与业务码就是它
//     声明的那个。少一个 mock 期望会让请求 500，这里立刻红，而不是把一份 500 悄悄录
//     进样本。不写盘。
//   - TestHTTPGoldenSamplesFresh —— 新鲜度守卫，总是运行：重录到临时目录，与已提交的
//     样本比文件集 + 逐字节内容。改了 json tag 或加了字段却忘了重新生成，这里变红。
//   - TestWriteHTTPGoldenSamples —— 重新生成这个动作本身，带 HTTP_GOLDEN_WRITE=1 才
//     执行，让 `go test ./...` 不写盘。
//
// 重新生成的命令：
//
//	HTTP_GOLDEN_WRITE=1 go test ./internal/api/ -run TestWriteHTTPGoldenSamples
//
// # 样本里哪些是契约、哪些只是这一次运行的偶然产物
//
// 这是这类样本最容易做砸的地方，边界划在这里：
//
//   - **是契约**：字段名、嵌套结构、JSON 类型、以及**字段在不在**（omitempty 的取舍）。
//     `results[].version` 永远出现、`overwritten_payload` 只在 conflict 时出现、
//     `items` 空页是 `[]` 而不是 `null`、错误信封没有 `data` 键而鉴权中间件的 401 有
//     ——桌面端的镜像结构体必须逐条对得上的就是这些。
//   - **不是契约，只是这次录制挑的常量**：sync_id、version、cursor、device_id、
//     content_hash、payload 正文。它们全部由本文件里的字面量经 repo mock 注入，一个都
//     不来自时钟、随机数或数据库自增。换一组值样本会变，但契约没变。
//   - **`msg` 是给人看的，不是给机器看的**。桌面端一律 switch `code`，从不读 `msg`。
//     它照样原样录进样本（删字段就是蒙混过关），只是它变了只说明文案改了。
//   - **`request_id` 在这里一律不出现**。cago 的 httputils.Error 给它挂了 omitempty，
//     值取自 trace span；本测试没有装 trace 组件，线上装了。所以样本钉的是「没有 trace
//     时的形状」，消费方必须容忍多出这一个键——这一条无法由样本本身表达，只能写在这里。
//
// 逐字节可复现靠三件事：(1) 值全是字面量；(2) 时钟不进任何响应体——sync_svc 的 now()
// 只用于落库字段（Createtime/Updatetime/DeletedAt）与 R6a 的窗口判定，一个都不出现在
// 应答里，因此不必把它钉死；R6a 那条判定则用「设备状态为 nil」（永远不超窗口）和
// 「LastSyncAt = 1」（1970 年，永远超窗口）这两个与当前时刻无关的极端值来选分支；
// (3) Authorization 头不录——JWT 里带 iat/exp，录进去就是一个每次都变的值。
package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/cago-frame/cago/database/db"
	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/consts"
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/api"
	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwtblacklist"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo/mock_device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo/mock_sync_repo"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
	"github.com/agentre-hub/agentre-server/internal/service/engine_svc"
	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

// goldenDirRel 样本在本仓里的位置（相对仓库根）。放在 internal/api/ 底下是因为契约的
// 真理就住在这里：改了 internal/api/sync/sync.go 的结构体，样本的 diff 会出现在同一次
// review 里。
const goldenDirRel = "internal/api/testdata/http-samples"

// regenCmd 样本过期时重新生成的确切命令，原样出现在守卫的失败信息里。
const regenCmd = "HTTP_GOLDEN_WRITE=1 go test ./internal/api/ -run TestWriteHTTPGoldenSamples"

// 录制用的账号与设备。它们只经 device JWT 的 claims 进服务端，请求体里没有身份入口。
const (
	goldenUserID   = int64(7)
	goldenDeviceID = int64(2)
)

// 录制用的固定标识与正文。全是字面量：换一组值样本会变，契约不变。
const (
	projectSyncID  = "01JZ7W2A8KZ4R5T6Y7U8I9O0P1"
	locationSyncID = "01JZ7W2A8KZ4R5T6Y7U8I9O0P2"
	losingSyncID   = "01JZ7W2A8KZ4R5T6Y7U8I9O0P3"
	agentFingerpr  = "fp-agentred-01"
	// avatarContent / avatarHash 必须互为 sha256，否则 PutAvatar 会走 30503 那条分支。
	// 录制自检里的 wantCode 就是这一对是否配对的检查。
	avatarContent = "data:image/png;base64,iVBORw0KGgo="
	avatarHash    = "e1e10747c2374f621aa59fefede6ef99dc6acdb41b267ab4af408d5529f89ea8"
	// goldenFingerprint 是录制这一批往返的那台桌面端自己的指纹：上行落库时
	// origin_fingerprint 记的就是它（决策 14）。
	goldenFingerprint = "fp-desktop-01"
	// otherFingerprint 是账号里另一台机器：冲突与合并的应答要指出被覆盖/被合并的
	// 那一版来自谁，R5 的「追回」记录靠它。
	otherFingerprint = "fp-desktop-02"
)

// syncMocks 是这一次录制的数据层。service 之上的每一层都是真的，只有这里是 mock。
type syncMocks struct {
	object    *mock_sync_repo.MockSyncObjectRepo
	state     *mock_sync_repo.MockSyncStateRepo
	avatar    *mock_sync_repo.MockSyncAvatarRepo
	localPath *mock_sync_repo.MockSyncLocalPathRepo
	device    *mock_device_repo.MockDeviceRepo
}

// authKind 决定这次请求带哪一份 Authorization。token 本身不进样本。
// 零值（不写这个字段）= 一份有效的桌面端 device JWT，绝大多数往返都是它。
type authKind int

const (
	// authExpired 一份已过期的 device JWT：桌面端 access token 到期时真实会碰到的那条路。
	authExpired authKind = iota + 1
	// authBrowser 用 SessionAuth + CSRF 跑浏览器专属的引擎读取契约。
	authBrowser
)

// exchange 是一次要录的往返：怎么发、数据层给什么、期望落在哪条分支上。
type exchange struct {
	name   string
	method string
	// path 含 query，GET 的入参就在这里。
	path string
	// body 请求体原文；GET 留空。
	body string
	auth authKind
	// arrange 布置数据层。nil = 这次请求根本到不了 service（例如 401）。
	arrange func(m *syncMocks)
	// wantStatus / wantCode 是录制自检的判据：录下来的必须确实落在声明的这条分支上。
	// 少布置一个 mock 期望会让请求 500，这两行让它当场红，而不是把 500 录进样本。
	wantStatus int
	wantCode   int
}

// recorded 是一条样本的落盘形状。
//
// 只有响应体是不够的：状态码同样是契约的一部分（400 的业务错误、404 的头像缺失、401
// 的鉴权失败，桌面端的重试与刷新逻辑全看它），而 .json 文件名里塞状态码是有损的。
// 请求原样带上，样本因此自解释——不必回头翻生成器就知道这是打哪个端点、发了什么。
// 请求头**刻意不录**：Authorization 里的 JWT 每次都不同，录了样本就永远不可复现。
type recorded struct {
	Request  recordedRequest  `json:"request"`
	Response recordedResponse `json:"response"`
}

type recordedRequest struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	// Body 是发出去的原文；GET 没有请求体，键直接省略。
	Body json.RawMessage `json:"body,omitempty"`
}

type recordedResponse struct {
	Status int `json:"status"`
	// Body 是服务端写回的原始字节。用 json.RawMessage 承接，MarshalIndent 只重排缩进、
	// 不重排键序——录下来的键序就是服务端真实发出的键序（结构体按声明序，gin.H 按字典序）。
	Body json.RawMessage `json:"body"`
}

// goldenExchanges 列出全部要录的往返。
//
// 第一刀只覆盖 /v1/sync/*：它的载荷最复杂、桌面端镜像得最多，也最容易漂。其余端点组
// 之后照这个形状加即可。
func goldenExchanges() []exchange {
	return []exchange{
		// ---------- 上行：三种处置各录一条 ----------
		{
			// server 从未见过这个同步标识：正常受理，分配新版本号。omitempty 的那一批
			// （reason / overwritten_* / merged_*）在这条里全部缺席，这就是「干净的
			// accepted 长什么样」。
			name:   "sync-push-accepted",
			method: http.MethodPost,
			path:   "/v1/sync/push",
			body: `{"items":[{"kind":"project","sync_id":"` + projectSyncID + `",` +
				`"base_version":0,"updated_at":1700000000000,"payload":{"name":"Alpha"}}]}`,
			arrange: func(m *syncMocks) {
				firstSyncDevice(m)
				m.object.EXPECT().Find(gomock.Any(), goldenUserID, projectSyncID).Return(nil, nil)
				m.state.EXPECT().NextVersion(gomock.Any(), goldenUserID, int64(1)).Return(int64(12), nil)
				m.object.EXPECT().Save(gomock.Any(), gomock.Any()).Return(nil)
			},
			wantStatus: http.StatusOK,
			wantCode:   0,
		},
		{
			// R4a/R5：基版本落后 → 判冲突。本次上行照常生效，应答带回被覆盖的版本、
			// 来源设备**和正文**——被覆盖的那一版只有 server 手上有，桌面端拿它落
			// 「被覆盖」记录。overwritten_payload 是整份样本里最要紧的一个字段。
			name:   "sync-push-conflict",
			method: http.MethodPost,
			path:   "/v1/sync/push",
			body: `{"items":[{"kind":"project","sync_id":"` + projectSyncID + `",` +
				`"base_version":8,"updated_at":1700000000000,"payload":{"name":"Alpha (本机改名)"}}]}`,
			arrange: func(m *syncMocks) {
				firstSyncDevice(m)
				m.object.EXPECT().Find(gomock.Any(), goldenUserID, projectSyncID).Return(&sync_entity.SyncObject{
					ID: 31, UserID: goldenUserID, Kind: sync_entity.KindProject, SyncID: projectSyncID,
					Payload: `{"name":"Alpha (另一端改名)"}`, Version: 11, OriginFingerprint: otherFingerprint,
				}, nil)
				m.state.EXPECT().NextVersion(gomock.Any(), goldenUserID, int64(1)).Return(int64(12), nil)
				m.object.EXPECT().Save(gomock.Any(), gomock.Any()).Return(nil)
			},
			wantStatus: http.StatusOK,
			wantCode:   0,
		},
		{
			// 单条被拒：类型不属于同步组。整批不受影响（整批拒会把桌面端的出站队列永久
			// 堵死），version 回 0 表示 server 上没有这一行。
			name:   "sync-push-rejected-kind",
			method: http.MethodPost,
			path:   "/v1/sync/push",
			body: `{"items":[{"kind":"chat_session","sync_id":"` + projectSyncID + `",` +
				`"base_version":0,"updated_at":1700000000000,"payload":{"title":"某次会话"}}]}`,
			arrange:    firstSyncDevice,
			wantStatus: http.StatusOK,
			wantCode:   0,
		},
		{
			// 单条被拒：载荷带了桌面端的本地自增 ID。桌面端有一份同规则的守卫
			// （syncwire.GuardPayload），两边规则不一致时坏的一边就是靠这个 reason 现形。
			name:   "sync-push-rejected-payload",
			method: http.MethodPost,
			path:   "/v1/sync/push",
			body: `{"items":[{"kind":"agent","sync_id":"` + projectSyncID + `",` +
				`"base_version":0,"updated_at":1700000000000,"payload":{"agent_backend_id":12}}]}`,
			arrange:    firstSyncDevice,
			wantStatus: http.StatusOK,
			wantCode:   0,
		},
		{
			// R4b：两端各为同一个（项目, agentred 指纹）建了一行，server 按 R4 合并成
			// 一行。落败那份的同步标识/版本/来源设备随应答回去，桌面端据此落 R5 记录。
			// merged_* 只有这条路径会出现。
			name:   "sync-push-location-merged",
			method: http.MethodPost,
			path:   "/v1/sync/push",
			body: `{"items":[{"kind":"project_location","sync_id":"` + locationSyncID + `",` +
				`"base_version":0,"updated_at":1700000000000,"project_sync_id":"` + projectSyncID + `",` +
				`"agentred_fingerprint":"` + agentFingerpr + `","payload":{"configured":true}}]}`,
			arrange: func(m *syncMocks) {
				firstSyncDevice(m)
				m.object.EXPECT().Find(gomock.Any(), goldenUserID, locationSyncID).Return(nil, nil)
				// 两次取号：先给墓碑（较小的那个），胜者再取一个更大的——下行按版本升序，
				// 接收端先看到墓碑，自然键上不会有一瞬间两行存活。
				m.state.EXPECT().NextVersion(gomock.Any(), goldenUserID, int64(1)).Return(int64(20), nil)
				m.object.EXPECT().FindLocationByNaturalKey(
					gomock.Any(), goldenUserID, projectSyncID, agentFingerpr,
				).Return(&sync_entity.SyncObject{
					ID: 33, UserID: goldenUserID, Kind: sync_entity.KindProjectLocation,
					SyncID: losingSyncID, ProjectSyncID: projectSyncID, AgentredFingerprint: agentFingerpr,
					Payload: `{"configured":true}`, Version: 9, OriginFingerprint: otherFingerprint,
				}, nil)
				m.state.EXPECT().NextVersion(gomock.Any(), goldenUserID, int64(1)).Return(int64(21), nil)
				m.object.EXPECT().Tombstone(gomock.Any(), int64(33), int64(20), gomock.Any()).Return(int64(1), nil)
				m.object.EXPECT().Save(gomock.Any(), gomock.Any()).Return(nil)
			},
			wantStatus: http.StatusOK,
			wantCode:   0,
		},

		// ---------- 上行：整批被拒的那一个码 ----------
		{
			// R6a：这台设备距上次「把增量消费干净」已超过墓碑保留窗口，上行一律被拒，
			// 它必须先拉一份全量快照。桌面端把这个码翻成 syncwire.ErrResyncRequired；
			// 不翻的话它跟网络抖动无从区分。
			//
			// LastSyncAt = 1（1970-01-01T00:00:00.001Z）让这条判定与当前时刻无关：
			// now - 1 恒大于 30 天。
			name:       "sync-push-resync-required",
			method:     http.MethodPost,
			path:       "/v1/sync/push",
			body:       `{"items":[{"kind":"project","sync_id":"` + projectSyncID + `","base_version":0}]}`,
			arrange:    staleSyncDevice,
			wantStatus: http.StatusBadRequest,
			wantCode:   code.SyncResyncRequired,
		},

		// ---------- 下行 ----------
		{
			// 增量一页：一条普通对象、一条带自然键的路径记录、一条墓碑。
			// project_sync_id / agentred_fingerprint 带 omitempty，第一条里因此看不到它们
			// ——「这两个键可能整个消失」正是桌面端镜像必须知道的事。
			// has_more 为 true：这一页取满了 limit，还有下一页。
			name:   "sync-pull-page",
			method: http.MethodGet,
			path:   "/v1/sync/pull?cursor=10&limit=3",
			arrange: func(m *syncMocks) {
				m.object.EXPECT().ListSince(gomock.Any(), goldenUserID, int64(10), 3).Return(
					[]*sync_entity.SyncObject{
						{
							Kind: sync_entity.KindProject, SyncID: projectSyncID,
							Payload: `{"name":"Alpha"}`, Version: 11,
							SyncUpdatedAt: 1700000000000, OriginFingerprint: otherFingerprint,
						},
						{
							Kind: sync_entity.KindProjectLocation, SyncID: locationSyncID,
							ProjectSyncID: projectSyncID, AgentredFingerprint: agentFingerpr,
							Payload: `{"configured":true}`, Version: 12,
							SyncUpdatedAt: 1700000001000, OriginFingerprint: otherFingerprint,
						},
						// 墓碑：deleted=true，正文是空对象（落库时由 payloadOrEmptyObject 保证）。
						// R6 的删除就是靠这一行到达各端。
						{
							Kind: sync_entity.KindAgent, SyncID: losingSyncID,
							Payload: `{}`, Version: 13,
							SyncUpdatedAt: 1700000002000, OriginFingerprint: otherFingerprint,
							DeletedAt: 1700000002000,
						},
					}, nil)
			},
			wantStatus: http.StatusOK,
			wantCode:   0,
		},
		{
			// 消费干净的一页：items 是 `[]` 而不是 `null`（controller 用 make 建的切片），
			// next_cursor 原样退回请求里的游标。R6a 的 30 天窗口只在这一刻刷新。
			name:   "sync-pull-empty",
			method: http.MethodGet,
			path:   "/v1/sync/pull?cursor=40&limit=200",
			arrange: func(m *syncMocks) {
				m.object.EXPECT().ListSince(gomock.Any(), goldenUserID, int64(40), 200).
					Return([]*sync_entity.SyncObject{}, nil)
				m.state.EXPECT().CurrentVersion(gomock.Any(), goldenUserID).Return(int64(40), nil)
				m.state.EXPECT().TouchDeviceState(gomock.Any(), goldenUserID, goldenDeviceID, gomock.Any()).Return(nil)
			},
			wantStatus: http.StatusOK,
			wantCode:   0,
		},
		{
			// 游标超出账号版本序列的头：这段历史 server 不认识（库被重建，或换了一套自建
			// 服务端）。与 resync-required 的处置**相反**——那一条是「你的历史不全」，
			// 这一条是「server 的历史没了」，桌面端必须把本地行重新上行。
			name:   "sync-pull-cursor-unknown",
			method: http.MethodGet,
			path:   "/v1/sync/pull?cursor=999&limit=200",
			arrange: func(m *syncMocks) {
				m.object.EXPECT().ListSince(gomock.Any(), goldenUserID, int64(999), 200).
					Return([]*sync_entity.SyncObject{}, nil)
				m.state.EXPECT().CurrentVersion(gomock.Any(), goldenUserID).Return(int64(40), nil)
			},
			wantStatus: http.StatusBadRequest,
			wantCode:   code.SyncCursorUnknown,
		},

		// ---------- 上报组：本机路径 ----------
		{
			// 整份快照上报。响应体没有任何字段，但 data 是 `{}` 而不是 `null`——
			// 空响应结构体也要序列化成一个对象，这就是空 data 的形状。
			name:   "sync-local-paths-accepted",
			method: http.MethodPost,
			path:   "/v1/sync/local-paths",
			body: `{"items":[{"project_sync_id":"` + projectSyncID + `",` +
				`"path":"/Users/someone/code/alpha"}]}`,
			arrange: func(m *syncMocks) {
				m.localPath.EXPECT().ReplaceSnapshot(
					gomock.Any(), goldenUserID, goldenDeviceID, gomock.Any()).Return(nil)
			},
			wantStatus: http.StatusOK,
			wantCode:   0,
		},

		// ---------- 头像 ----------
		{
			name:   "sync-avatar-put-accepted",
			method: http.MethodPost,
			path:   "/v1/sync/avatars",
			body: `{"content_hash":"` + avatarHash + `","content_type":"image/png",` +
				`"content":"` + avatarContent + `"}`,
			arrange: func(m *syncMocks) {
				m.avatar.EXPECT().Save(gomock.Any(), gomock.Any()).Return(nil)
			},
			wantStatus: http.StatusOK,
			wantCode:   0,
		},
		{
			// 正文与声明的哈希不符：内容寻址的前提被破坏，直接拒。
			name:   "sync-avatar-put-hash-mismatch",
			method: http.MethodPost,
			path:   "/v1/sync/avatars",
			body: `{"content_hash":"0000000000000000000000000000000000000000000000000000000000000000",` +
				`"content_type":"image/png","content":"` + avatarContent + `"}`,
			wantStatus: http.StatusBadRequest,
			wantCode:   code.SyncAvatarHashMismatch,
		},
		{
			name:   "sync-avatar-get-found",
			method: http.MethodGet,
			path:   "/v1/sync/avatars?content_hash=" + avatarHash,
			arrange: func(m *syncMocks) {
				m.avatar.EXPECT().Find(gomock.Any(), goldenUserID, avatarHash).Return(&sync_entity.SyncAvatar{
					UserID: goldenUserID, ContentHash: avatarHash,
					ContentType: "image/png", Content: avatarContent,
					Createtime: 1700000000000,
				}, nil)
			},
			wantStatus: http.StatusOK,
			wantCode:   0,
		},
		{
			// 账号下没有这个哈希：桌面端据此降级成占位字母头像，而不是无限重试。
			// 这是 /v1/sync/* 里唯一一个 404——错误信封的形状与 400 那几条一样，
			// 区别只在 HTTP 状态码，所以状态码必须是样本的一部分。
			name:   "sync-avatar-get-not-found",
			method: http.MethodGet,
			path:   "/v1/sync/avatars?content_hash=" + avatarHash,
			arrange: func(m *syncMocks) {
				m.avatar.EXPECT().Find(gomock.Any(), goldenUserID, avatarHash).Return(nil, nil)
			},
			wantStatus: http.StatusNotFound,
			wantCode:   code.SyncAvatarNotFound,
		},

		// ---------- 请求绑定：第三种错误信封 ----------
		{
			// 请求过不了 binding 校验。这是**镜像结构体漂了的客户端真正会看到的东西**：
			// 少发一个 binding:"required" 的字段，拿回的既不是业务码也不是鉴权码，而是
			// 这个 -1。
			//
			// 信封是第三种形状：cago 直接 gin.H 出 {"code":-1,"msg":…}，没有 data 键，
			// 而 msg 里用的是 **Go 字段名**（Items），不是 json 名（items）——想按字段名
			// 定位问题的消费方会扑空。这两点都不是本次改动引入的，样本只是把它们记下来。
			name:       "sync-push-invalid-request",
			method:     http.MethodPost,
			path:       "/v1/sync/push",
			body:       `{"items":[]}`,
			wantStatus: http.StatusBadRequest,
			wantCode:   -1,
		},

		// ---------- 鉴权：另一种错误信封 ----------
		{
			// access token 过期——桌面端每天都会碰到，碰到就去刷新。
			//
			// 这条录的形状与上面那几个业务错误**不一样**：DeviceJWT 中间件用 gin.H
			// 直接 abort，因此有一个 `"data": null` 键，而 service 抛的
			// httputils.Error 根本没有 data 键。同一批端点上并存两种错误信封，
			// 消费方不能假定 data 一定在（或一定不在）。
			name:       "sync-push-unauthorized-expired-token",
			method:     http.MethodPost,
			path:       "/v1/sync/push",
			body:       `{"items":[{"kind":"project","sync_id":"` + projectSyncID + `","base_version":0}]}`,
			auth:       authExpired,
			wantStatus: http.StatusUnauthorized,
			wantCode:   code.JWTSignatureInvalid,
		},

		// 浏览器仅得到掩码后的供应商视图；API Key 即使存储在同步载荷中，也不能出现在
		// 这个 SessionAuth 响应。用实际引擎 service，而不是手写 controller 桩。
		{
			name:   "engine-providers-browser-list",
			method: http.MethodGet,
			path:   "/v1/engine/providers",
			auth:   authBrowser,
			arrange: func(m *syncMocks) {
				m.object.EXPECT().ListByKinds(gomock.Any(), goldenUserID, []string{sync_entity.KindLLMProvider}).
					Return([]*sync_entity.SyncObject{{
						Kind: sync_entity.KindLLMProvider, SyncID: "anthropic-main",
						Payload: `{"name":"Anthropic","type":"anthropic","base_url":"https://api.anthropic.com","api_key":"sk-engine-secret","models":[]}`,
					}}, nil)
			},
			wantStatus: http.StatusOK,
			wantCode:   0,
		},

		// 引擎快照是唯一允许明文凭据与本机 CLI 路径下行的 HTTP 契约。样本同时钉住
		// 指纹过滤：另一台设备的覆盖绝不能随本次响应泄漏。
		{
			name:   "engine-snapshot-device",
			method: http.MethodGet,
			path:   "/v1/engine/snapshot",
			arrange: func(m *syncMocks) {
				m.device.EXPECT().Find(gomock.Any(), goldenDeviceID).Return(&device_entity.Device{
					ID: goldenDeviceID, UserID: goldenUserID, Fingerprint: agentFingerpr,
					Status: consts.ACTIVE,
				}, nil)
				m.object.EXPECT().ListByKinds(gomock.Any(), goldenUserID, []string{
					sync_entity.KindLLMProvider, sync_entity.KindAgentBackendCLI,
				}).Return([]*sync_entity.SyncObject{
					{Kind: sync_entity.KindLLMProvider, SyncID: "anthropic-main", Payload: `{"name":"Anthropic","type":"anthropic","base_url":"https://api.anthropic.com","api_key":"sk-engine-secret","models":[]}`},
					{Kind: sync_entity.KindAgentBackendCLI, ProjectSyncID: "backend-1", AgentredFingerprint: agentFingerpr, Payload: `{"cli_path":"/usr/local/bin/claude"}`},
					{Kind: sync_entity.KindAgentBackendCLI, ProjectSyncID: "backend-1", AgentredFingerprint: "other-fingerprint", Payload: `{"cli_path":"/opt/claude"}`},
				}, nil)
			},
			wantStatus: http.StatusOK,
			wantCode:   0,
		},
	}
}

// firstSyncDevice 让 R6a 的窗口判定走「这台设备还没有同步状态」那条分支：首次登录的
// 设备不算超窗口。与当前时刻无关，因此录制逐次可复现。
func firstSyncDevice(m *syncMocks) {
	m.state.EXPECT().FindDeviceState(gomock.Any(), goldenUserID, goldenDeviceID).Return(nil, nil)
	pushingDevice(m)
}

// pushingDevice 交出上行这一端自己的设备行：Push 要把它的**指纹**记进
// origin_fingerprint（决策 14），凭据里只有设备号。
func pushingDevice(m *syncMocks) {
	m.device.EXPECT().Find(gomock.Any(), goldenDeviceID).Return(&device_entity.Device{
		ID: goldenDeviceID, UserID: goldenUserID, Fingerprint: goldenFingerprint,
		Status: consts.ACTIVE,
	}, nil)
}

// staleSyncDevice 让 R6a 判定走「超窗口」那条分支。LastSyncAt = 1 是 1970 年，
// now - 1 恒大于 30 天，同样与当前时刻无关。
func staleSyncDevice(m *syncMocks) {
	m.state.EXPECT().FindDeviceState(gomock.Any(), goldenUserID, goldenDeviceID).Return(
		&sync_entity.DeviceSyncState{UserID: goldenUserID, DeviceID: goldenDeviceID, LastSyncAt: 1}, nil)
}

// record 跑一次真实服务端，把这一次往返录成落盘字节。
//
// 落盘与守卫共用它：守卫比的就是生成器此刻会写出的东西。
func record(t *testing.T, ex exchange) []byte {
	t.Helper()
	gin.SetMode(gin.TestMode)
	// DeviceJWT 中间件要查吊销黑名单，那条链路直接读 redis.Default()。
	hubtest.Redis(t)

	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)
	m := &syncMocks{
		object:    mock_sync_repo.NewMockSyncObjectRepo(ctrl),
		state:     mock_sync_repo.NewMockSyncStateRepo(ctrl),
		avatar:    mock_sync_repo.NewMockSyncAvatarRepo(ctrl),
		localPath: mock_sync_repo.NewMockSyncLocalPathRepo(ctrl),
		device:    mock_device_repo.NewMockDeviceRepo(ctrl),
	}
	sync_repo.RegisterSyncObject(m.object)
	sync_repo.RegisterSyncState(m.state)
	sync_repo.RegisterSyncAvatar(m.avatar)
	sync_repo.RegisterSyncLocalPath(m.localPath)
	device_repo.RegisterDevice(m.device)
	engine_svc.SetDefault(engine_svc.New())
	auth_svc.SetDefault(auth_svc.New(redis.Default(), session.New(redis.Default(), "server_session", 86400)))
	// 快照端点要先确认「这台设备归调用方且还能用」，判定归 device_svc.OwnedDevice；
	// 它只走上面装好的 device_repo mock，配置与签名器都用不上。
	device_svc.SetDefault(device_svc.New(device_svc.Config{}, nil, jwtblacklist.New(redis.Default())))
	// 没有 EXPECT 的调用会被 gomock 判失败：这些样本都不该碰到浏览器的执行目标排列。

	// Push 外层有一个事务。gin 造出来的请求 ctx 里没有数据库实例，db.Ctx 会回落到默认
	// 库，所以这里把 sqlmock 装成默认库——真正的 SQL 全被 repo mock 挡掉了，落到
	// sqlmock 的只有 Begin/Commit。
	//
	// Begin/Commit 不分端点一律备着（不用事务的端点就是没人来取），也刻意不调
	// ExpectationsWereMet：这里要断言的是「录下来的响应对不对」，那件事由下面的
	// wantStatus/wantCode 判，SQL 语句序列是 sync_svc 自己的单元测试的事。
	_, gormDB, sqlMock := hubtest.Database(t)
	db.SetDefault(gormDB)
	sqlMock.ExpectBegin()
	sqlMock.ExpectCommit()

	if ex.arrange != nil {
		ex.arrange(m)
	}

	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{
		Cfg:    &bootstrap.ServerConfig{RateLimit: bootstrap.RLConfig{AuthorizePerIPPerMin: 100}},
		Signer: signer,
	}).Router(context.Background(), testMux.Router))

	ttl := time.Hour
	if ex.auth == authExpired {
		// 早已过期，且远超 Verify 的 60s 时钟容差。
		ttl = -2 * time.Hour
	}
	token, _, err := signer.Sign(
		jwt.Claims{UID: goldenUserID, DID: goldenDeviceID, Kind: device_entity.KindDesktop}, ttl)
	require.NoError(t, err)

	var reqBody io.Reader
	if ex.body != "" {
		reqBody = strings.NewReader(ex.body)
	}
	req := httptest.NewRequest(ex.method, ex.path, reqBody)
	if ex.auth == authBrowser {
		sid, sess, err := auth_svc.Default().StartSession(context.Background(), goldenUserID)
		require.NoError(t, err)
		req.AddCookie(&http.Cookie{Name: "server_session", Value: sid})
		req.Header.Set("X-CSRF-Token", sess.CSRFToken)
	} else {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if ex.body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	testMux.IRouter.(*gin.Engine).ServeHTTP(rec, req)

	// 录制自检：这一次往返必须确实落在声明的那条分支上。少布置一个 mock 期望会让请求
	// 500，没有这两行的话那份 500 会被安静地录成样本。
	require.Equal(t, ex.wantStatus, rec.Code,
		"%s：HTTP 状态与声明不符，响应体 %s", ex.name, rec.Body.String())
	var envelope struct {
		Code int `json:"code"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &envelope),
		"%s：响应体不是合法 JSON：%s", ex.name, rec.Body.String())
	require.Equal(t, ex.wantCode, envelope.Code,
		"%s：业务码与声明不符，响应体 %s", ex.name, rec.Body.String())

	out := recorded{
		Request:  recordedRequest{Method: ex.method, Path: ex.path},
		Response: recordedResponse{Status: rec.Code, Body: json.RawMessage(rec.Body.Bytes())},
	}
	if ex.body != "" {
		out.Request.Body = json.RawMessage(ex.body)
	}
	// 关掉 HTML 转义有两个理由，第二个是硬要求：query 里的 `&` 不会变成 `&`
	// （可读）；以及**服务端写回的字节原样穿过外壳**——json.Marshal 默认会把
	// RawMessage 里的 `<` `>` `&` 重新转义一遍，那样录下来的就不再是服务端发出的
	// 那串字节了。Encoder.Encode 自带结尾换行。
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	require.NoError(t, enc.Encode(out), "%s：样本序列化失败", ex.name)
	return buf.Bytes()
}

// repoRoot 从当前工作目录向上找到带 go.mod 的仓库根。样本目录因此由本仓自己定位，
// 不依赖工作区里任何兄弟 checkout 存在。
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	require.NoError(t, err)
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		require.NotEqual(t, dir, parent, "从工作目录向上找不到 go.mod")
		dir = parent
	}
}

// writeGoldenSamples 把全部样本录进 dir（落盘与守卫的临时目录共用这一条路径）。
func writeGoldenSamples(t *testing.T, dir string) {
	t.Helper()
	require.NoError(t, os.MkdirAll(dir, 0o755), "创建样本目录")
	for _, ex := range goldenExchanges() {
		out := filepath.Join(dir, ex.name+".json")
		require.NoError(t, os.WriteFile(out, record(t, ex), 0o644), "写样本 %s", ex.name)
	}
}

// listGoldenNames 列出目录里全部 .json 样本文件名（已排序）。
func listGoldenNames(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	require.NoError(t, err, "读样本目录 %s", dir)
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".json" {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	return names
}

// TestHTTPGoldenSamples 录一遍全部往返并当场自检状态码与业务码。不写盘。
func TestHTTPGoldenSamples(t *testing.T) {
	for _, ex := range goldenExchanges() {
		t.Run(ex.name, func(t *testing.T) {
			require.NotEmpty(t, record(t, ex))
		})
	}
}

// TestHTTPGoldenSamplesFresh 新鲜度守卫：已提交的样本必须就是生成器此刻会录出来的东西。
//
// 只有录制自检是不够的——给 internal/api/sync 的响应结构体改个 json tag，自检照样绿
// （它只看 code 和状态码），而仓里已提交的样本还是旧形状，任何对着旧样本写的消费方也
// 照样绿，改动就在跨仓的缝里静默消失了。这里把样本重录到临时目录，与仓里的副本比
// 文件集 + 逐字节内容，把那条缝焊死。
func TestHTTPGoldenSamplesFresh(t *testing.T) {
	committed := filepath.Join(repoRoot(t), goldenDirRel)
	fresh := t.TempDir()
	writeGoldenSamples(t, fresh)

	// 文件集一致：删了生成器里的往返却留着 .json（或反过来）同样是漂移。
	require.Equal(t, listGoldenNames(t, fresh), listGoldenNames(t, committed),
		"%s 的样本文件集与生成器不一致，重新生成：\n\t%s", goldenDirRel, regenCmd)

	for _, ex := range goldenExchanges() {
		t.Run(ex.name, func(t *testing.T) {
			got, err := os.ReadFile(filepath.Join(committed, ex.name+".json"))
			require.NoError(t, err, "读已提交的样本 %s", ex.name)
			require.Equal(t, string(record(t, ex)), string(got),
				"样本 %s 已过期（HTTP 契约改了但样本没重新生成），重新生成：\n\t%s", ex.name, regenCmd)
		})
	}
}

// TestWriteHTTPGoldenSamples 重新生成样本并写进仓里。写盘是显式动作：不带
// HTTP_GOLDEN_WRITE=1 直接跳过，`go test ./...` 因此不写盘。
func TestWriteHTTPGoldenSamples(t *testing.T) {
	if os.Getenv("HTTP_GOLDEN_WRITE") != "1" {
		t.Skip("设 HTTP_GOLDEN_WRITE=1 重新生成 HTTP 契约样本")
	}
	dir := filepath.Join(repoRoot(t), goldenDirRel)
	writeGoldenSamples(t, dir)
	t.Logf("HTTP 契约样本已写入 %s", dir)
}
