// Command webe2e is the harness for the web full-chain e2e (agentre-server
// e2e/web/, spec docs/specs/2026-08-10-web-session-access.md 测试接缝 10). It is
// a test tool, never part of the shipped server.
//
// The web frontend's login ends at GitHub OAuth, which nobody can click in an
// e2e, so the runner seeds the identity straight into the developer's
// PostgreSQL + Redis:
//
//   - a throwaway user (the account);
//   - one kind=agentred device + a refresh token for the real `agentred run`
//     daemon to claim (it trades the token over real HTTP at startup);
//   - optionally (--desktop-fingerprint) one kind=desktop device + its refresh
//     token, for the scenario that drives the real Wails desktop app and a
//     browser against that same agentred;
//   - one Redis browser session (sid → {user_id, csrf_token}) that becomes the
//     logged-in browser via the session cookie;
//   - the account-level workspace (agents with their exec-target chains, a
//     project and its path on that agentred) that "start a new conversation from
//     the web" reads — see seedWorkspace.
//
// Every run gets its own account (email embeds the run id); `cleanup` removes
// exactly the rows that run created — scoped by user id, never a TRUNCATE, and
// never anything that belongs to anyone else.
package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	goredis "github.com/redis/go-redis/v9"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
)

// accountEmail is the only handle a run has on its own rows. It embeds the run
// id so `cleanup` can find exactly this run's account and nothing else.
func accountEmail(runID string) string { return "webe2e-" + runID + "@e2e.invalid" }

// agentredDeviceName 是那台真跑起来的 agentred 在设备列表里的名字（spec 按它取行）。
const agentredDeviceName = "webe2e-agentred"

// desktopDeviceName 是「桌面端 + 浏览器同时对着一台 agentred」那一场景里，真跑起来的
// Wails 桌面端在设备列表里的名字。只有 seed 收到 --desktop-fingerprint 时才存在。
const desktopDeviceName = "webe2e-desktop"

func sessionSID(runID string) string { return "webe2e-" + runID }

// seededDevice 是一台被播种的设备 + 一枚它能换取访问令牌的刷新令牌。
// agentred 与桌面端用的是同一份形状：都靠 POST /v1/oauth/token/refresh 换真令牌。
type seededDevice struct {
	DeviceID     int64  `json:"device_id"`
	Fingerprint  string `json:"fingerprint"`
	RefreshToken string `json:"refresh_token"`
}

type browserSession struct {
	SID       string `json:"sid"`
	CSRFToken string `json:"csrf_token"`
}

// seededWorkspace 是账号级工作区里被播种的那几样东西（块 1 的同步组），
// 「从 web 发起新对话」这条流程全靠它才走得起来：浏览器挑的是 Agent 与项目，
// 服务端的派发计划（workspace_svc.WebDispatchPlan）读的就是这些行。
//
// 名字与同步标识只有这一份来源，runner 原样透传给 spec（WEBE2E_WORKSPACE）。
type seededWorkspace struct {
	// AgentReady 的执行目标链是「本机档（浏览器语境下应跳过）→ 在线 agentred」。
	AgentReadySyncID string `json:"agent_ready_sync_id"`
	AgentReadyName   string `json:"agent_ready_name"`
	// AgentBlocked 一档可用的都没有：本机 / 未配对 / 离线，各一档。
	AgentBlockedName string `json:"agent_blocked_name"`
	ProjectName      string `json:"project_name"`
	// ProjectPath 是该项目在那台在线 agentred 上的绝对路径（= 新对话的 cwd）。
	ProjectPath        string `json:"project_path"`
	AgentredDeviceName string `json:"agentred_device_name"`
	// OfflineDeviceName 是离线那一档指向的机器，逐档说明原因时要认得出是它。
	OfflineDeviceName string `json:"offline_device_name"`
}

type seedResult struct {
	RunID    string        `json:"run_id"`
	UserID   int64         `json:"user_id"`
	Email    string        `json:"email"`
	Agentred *seededDevice `json:"agentred"`
	// Desktop 只在 seed 收到 --desktop-fingerprint 时非空：真桌面端（Wails，-tags e2e）
	// 用它换到访问令牌，以同一个账号的身份接上同一台 agentred。
	Desktop   *seededDevice    `json:"desktop,omitempty"`
	Session   browserSession   `json:"session"`
	Workspace *seededWorkspace `json:"workspace"`
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "seed":
		err = runSeed(os.Args[2:])
	case "cleanup":
		err = runCleanup(os.Args[2:])
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "webe2e %s: %v\n", os.Args[1], err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `webe2e — local end-to-end harness for the web full chain (test tool)

  webe2e seed     --dsn DSN --redis-addr HOST:PORT [--redis-password PW --redis-db N]
                  --run-id ID --agentred-fingerprint FP --project-path DIR
                  [--desktop-fingerprint FP]
  webe2e cleanup  --dsn DSN --redis-addr HOST:PORT [--redis-password PW --redis-db N]
                  --run-id ID
`)
}

// registerRedisFlags 在 fs 上注册 redis 连接受验参数(与 configs/config.yaml 的 redis 段对应),
// 返回解析后才能安全取值的三元组(flag 指针在 fs.Parse 之后才被填上)。
func registerRedisFlags(fs *flag.FlagSet) (*string, *string, *int) {
	addr := fs.String("redis-addr", os.Getenv("WEBE2E_REDIS_ADDR"), "Redis host:port")
	password := fs.String("redis-password", os.Getenv("WEBE2E_REDIS_PASSWORD"), "Redis password")
	db := fs.Int("redis-db", 0, "Redis db number")
	return addr, password, db
}

func openDB(dsn string) (*gorm.DB, error) {
	if strings.TrimSpace(dsn) == "" {
		return nil, fmt.Errorf("--dsn is required (the harness reads it from agentre-server/configs/config.yaml)")
	}
	gdb, err := gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: gormlogger.Discard})
	if err != nil {
		return nil, fmt.Errorf("connect postgres: %w", err)
	}
	sqlDB, err := gdb.DB()
	if err != nil {
		return nil, err
	}
	if err := sqlDB.Ping(); err != nil {
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return gdb, nil
}

func runSeed(args []string) error {
	fs := flag.NewFlagSet("seed", flag.ExitOnError)
	dsn := fs.String("dsn", os.Getenv("WEBE2E_DSN"), "PostgreSQL DSN")
	runID := fs.String("run-id", "", "unique id for this run")
	agentredFP := fs.String("agentred-fingerprint", "", "the agentred device fingerprint (sha256:<hex> of the daemon instance uuid)")
	desktopFP := fs.String("desktop-fingerprint", "", "optional: also seed a kind=desktop device with this fingerprint (the desktop+web dual scenario)")
	projectPath := fs.String("project-path", "", "absolute path of the seeded project on the agentred host (the new conversation's cwd)")
	redisAddr, redisPassword, redisDB := registerRedisFlags(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*runID) == "" {
		return fmt.Errorf("--run-id is required")
	}
	if strings.TrimSpace(*agentredFP) == "" {
		return fmt.Errorf("--agentred-fingerprint is required")
	}
	if strings.TrimSpace(*projectPath) == "" {
		return fmt.Errorf("--project-path is required")
	}
	gdb, err := openDB(*dsn)
	if err != nil {
		return err
	}
	rc := goredis.NewClient(&goredis.Options{
		Addr: *redisAddr, Password: *redisPassword, DB: *redisDB,
	})
	if err := rc.Ping(context.Background()).Err(); err != nil {
		return fmt.Errorf("ping redis: %w", err)
	}

	now := time.Now().UnixMilli()
	out := &seedResult{RunID: *runID, Email: accountEmail(*runID)}
	err = gdb.Transaction(func(tx *gorm.DB) error {
		if err := tx.Raw(
			`INSERT INTO users (email, email_verified, display_name, avatar_url, status, createtime, updatetime)
			 VALUES (?, true, ?, '', 1, ?, ?) RETURNING id`,
			out.Email, "webe2e "+*runID, now, now,
		).Scan(&out.UserID).Error; err != nil {
			return fmt.Errorf("insert user: %w", err)
		}
		agentred, err := seedDevice(tx, out.UserID, agentredDeviceName, "agentred", *agentredFP, now)
		if err != nil {
			return err
		}
		out.Agentred = agentred
		if fp := strings.TrimSpace(*desktopFP); fp != "" {
			desktop, derr := seedDevice(tx, out.UserID, desktopDeviceName, "desktop", fp, now)
			if derr != nil {
				return derr
			}
			out.Desktop = desktop
		}
		ws, err := seedWorkspace(tx, out.UserID, *runID, *agentredFP, *projectPath, now)
		if err != nil {
			return err
		}
		out.Workspace = ws
		return nil
	})
	if err != nil {
		return err
	}

	// 浏览器 session 直接写 Redis(mirror auth_svc.StartSession 的存法):
	// session:<sid> = {"user_id":N,"csrf_token":"...","created_at":ms}。
	out.Session = browserSession{SID: sessionSID(*runID)}
	csrf, err := randomToken()
	if err != nil {
		return err
	}
	out.Session.CSRFToken = csrf
	body, _ := json.Marshal(map[string]any{
		"user_id":    out.UserID,
		"csrf_token": csrf,
		"created_at": now,
	})
	const sessionTTL = 14 * 24 * 3600 // seconds, mirrors auth_svc 的滑动 TTL
	if err := rc.Set(context.Background(), "session:"+out.Session.SID, body, time.Duration(sessionTTL)*time.Second).Err(); err != nil {
		return fmt.Errorf("seed browser session: %w", err)
	}
	return emit(out)
}

// seedDevice 插一台设备行 + 一枚刷新令牌，返回调用方要透传出去的三元组。
//
// 服务器只存 sha256(refresh_token)（device_svc.sha256Hex），所以这里存哈希、把明文
// 交出去：真 agentred / 真桌面端都靠真实的 POST /v1/oauth/token/refresh 换访问令牌，
// 一枚坏令牌会在那一步大声失败，而不是变成半登录的进程。
func seedDevice(tx *gorm.DB, userID int64, name, kind, fingerprint string, now int64) (*seededDevice, error) {
	out := &seededDevice{Fingerprint: fingerprint}
	if err := tx.Raw(
		`INSERT INTO devices (user_id, name, kind, platform, version, fingerprint, last_seen_at, status, createtime, updatetime)
		 VALUES (?, ?, ?, 'darwin', 'e2e', ?, ?, 1, ?, ?) RETURNING id`,
		userID, name, kind, fingerprint, now, now, now,
	).Scan(&out.DeviceID).Error; err != nil {
		return nil, fmt.Errorf("insert %s device: %w", kind, err)
	}
	plain, err := randomToken()
	if err != nil {
		return nil, err
	}
	out.RefreshToken = plain
	sum := sha256.Sum256([]byte(plain))
	if err := tx.Exec(
		`INSERT INTO device_tokens (device_id, access_jti, refresh_token_hash, refresh_expires_at, createtime)
		 VALUES (?, '', ?, ?, ?)`,
		out.DeviceID, hex.EncodeToString(sum[:]), now+30*24*3600*1000, now,
	).Error; err != nil {
		return nil, fmt.Errorf("insert %s device token: %w", kind, err)
	}
	return out, nil
}

// seedWorkspace 播种「从 web 发起新对话」要用到的那一份账号级工作区，并返回
// spec 需要知道的名字与同步标识。
//
// 两条执行目标链是刻意造出来的，各自锁住 R15 的一面：
//
//   - AgentReady：第 1 档是 device_id 为空的「本机」引用（backend 行的
//     agentred_fingerprint 为空），第 2 档是那台真的在线的 agentred。R15d 要求
//     浏览器语境下跳过第 1 档，因此派发必须落在第 2 档上。
//   - AgentBlocked：本机 / 未配对（指纹不属于任何设备行）/ 离线（设备在账号里但
//     从不连中继）各一档，一档可用的都没有 —— 逐档说明原因那一屏的素材。
//
// 项目路径只配在那台在线 agentred 上（sync_objects 的 project_location 行），
// 派发计划因此选得出 cwd；这也是 picker 里项目清单的唯一来源。
func seedWorkspace(tx *gorm.DB, userID int64, runID, agentredFP, projectPath string, now int64) (*seededWorkspace, error) {
	ws := &seededWorkspace{
		AgentReadySyncID:   "webe2e-agent-ready",
		AgentReadyName:     "webe2e Agent Ready",
		AgentBlockedName:   "webe2e Agent Blocked",
		ProjectName:        "webe2e-project-alpha",
		ProjectPath:        projectPath,
		AgentredDeviceName: agentredDeviceName,
		OfflineDeviceName:  "webe2e-offline-box",
	}
	const (
		agentBlockedSyncID = "webe2e-agent-blocked"
		projectSyncID      = "webe2e-project"
	)
	// 未配对那一档的指纹不属于任何设备行；离线那一档的机器在账号里但从不连中继。
	unpairedFP := fingerprintFor(runID + ":unpaired")
	offlineFP := fingerprintFor(runID + ":offline")

	// 离线那一档的指代对象：一台真的在账号里、但永远不会连上中继的 agentred。
	// 名字不含 "webe2e-agentred"，否则设备列表里按名字取行的用例会一次匹配到两行。
	if err := tx.Exec(
		`INSERT INTO devices (user_id, name, kind, platform, version, fingerprint, last_seen_at, status, createtime, updatetime)
		 VALUES (?, ?, 'agentred', 'linux', 'e2e', ?, ?, 1, ?, ?)`,
		userID, ws.OfflineDeviceName, offlineFP, now, now, now,
	).Error; err != nil {
		return nil, fmt.Errorf("insert offline agentred device: %w", err)
	}

	version := int64(0)
	insert := func(kind, syncID, projectSyncID, fingerprint string, payload map[string]any) error {
		body, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		version++
		if err := tx.Exec(
			`INSERT INTO sync_objects
			   (user_id, kind, sync_id, project_sync_id, agentred_fingerprint, payload,
			    version, sync_updated_at, source_device_id, deleted_at, createtime, updatetime)
			 VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?, 0, 0, ?, ?)`,
			userID, kind, syncID, projectSyncID, fingerprint, string(body), version, now, now, now,
		).Error; err != nil {
			return fmt.Errorf("insert sync_object %s/%s: %w", kind, syncID, err)
		}
		return nil
	}

	const (
		backendLocal    = "webe2e-backend-local"
		backendAgentred = "webe2e-backend-agentred"
		backendUnpaired = "webe2e-backend-unpaired"
		backendOffline  = "webe2e-backend-offline"
	)
	steps := []struct {
		kind          string
		syncID        string
		projectSyncID string
		fingerprint   string
		payload       map[string]any
	}{
		{"project", projectSyncID, "", "", map[string]any{"name": ws.ProjectName}},
		{"project_location", "webe2e-project-loc", projectSyncID, agentredFP, map[string]any{"path": projectPath}},

		// backend 行：指纹这一列决定那一档解析成什么（空 = 本机引用）。
		{"agent_backend", backendLocal, "", "", map[string]any{"type": "claudecode"}},
		{"agent_backend", backendAgentred, "", agentredFP, map[string]any{"type": "claudecode"}},
		{"agent_backend", backendUnpaired, "", unpairedFP, map[string]any{"type": "claudecode"}},
		{"agent_backend", backendOffline, "", offlineFP, map[string]any{"type": "claudecode"}},

		{"agent", ws.AgentReadySyncID, "", "", map[string]any{"name": ws.AgentReadyName, "avatar_color": "#22c55e"}},
		{"agent_exec_target", "webe2e-target-ready-1", "", "", map[string]any{
			"agent_sync_id": ws.AgentReadySyncID, "backend_sync_id": backendLocal, "sort_order": 1,
		}},
		{"agent_exec_target", "webe2e-target-ready-2", "", "", map[string]any{
			"agent_sync_id": ws.AgentReadySyncID, "backend_sync_id": backendAgentred, "sort_order": 2,
		}},

		{"agent", agentBlockedSyncID, "", "", map[string]any{"name": ws.AgentBlockedName, "avatar_color": "#ef4444"}},
		{"agent_exec_target", "webe2e-target-blocked-1", "", "", map[string]any{
			"agent_sync_id": agentBlockedSyncID, "backend_sync_id": backendLocal, "sort_order": 1,
		}},
		{"agent_exec_target", "webe2e-target-blocked-2", "", "", map[string]any{
			"agent_sync_id": agentBlockedSyncID, "backend_sync_id": backendUnpaired, "sort_order": 2,
		}},
		{"agent_exec_target", "webe2e-target-blocked-3", "", "", map[string]any{
			"agent_sync_id": agentBlockedSyncID, "backend_sync_id": backendOffline, "sort_order": 3,
		}},
	}
	for _, s := range steps {
		if err := insert(s.kind, s.syncID, s.projectSyncID, s.fingerprint, s.payload); err != nil {
			return nil, err
		}
	}
	return ws, nil
}

// fingerprintFor 造一个与设备指纹同形（sha256:<hex>）的稳定指纹。
func fingerprintFor(seed string) string {
	sum := sha256.Sum256([]byte(seed))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func randomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b)), nil
}

type cleanupResult struct {
	RunID   string           `json:"run_id"`
	UserID  int64            `json:"user_id"`
	Found   bool             `json:"found"`
	Deleted map[string]int64 `json:"deleted"`
	Residue map[string]int64 `json:"residue"`
}

func runCleanup(args []string) error {
	fs := flag.NewFlagSet("cleanup", flag.ExitOnError)
	dsn := fs.String("dsn", os.Getenv("WEBE2E_DSN"), "PostgreSQL DSN")
	runID := fs.String("run-id", "", "run id used at seed time")
	redisAddr, redisPassword, redisDB := registerRedisFlags(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*runID) == "" {
		return fmt.Errorf("--run-id is required")
	}
	gdb, err := openDB(*dsn)
	if err != nil {
		return err
	}
	rc := goredis.NewClient(&goredis.Options{
		Addr: *redisAddr, Password: *redisPassword, DB: *redisDB,
	})

	out := &cleanupResult{RunID: *runID, Deleted: map[string]int64{}, Residue: map[string]int64{}}
	var ids []int64
	if err := gdb.Raw(`SELECT id FROM users WHERE email = ?`, accountEmail(*runID)).Scan(&ids).Error; err != nil {
		return err
	}
	if len(ids) == 0 {
		return emit(out)
	}
	out.Found = true
	out.UserID = ids[0]
	uid := out.UserID

	// device_tokens / web device rows hang off devices; devices/users last.
	// 浏览器自己注册的 kind=web 设备(RegisterWeb)同样挂在同一个 user_id 下,
	// 一并清掉 —— 这正是 cleanup 按账号而非按设备枚举的原因。
	steps := []struct {
		table string
		sql   string
	}{
		{"device_tokens", `DELETE FROM device_tokens WHERE device_id IN (SELECT id FROM devices WHERE user_id = ?)`},
		{"device_flow_codes", `DELETE FROM device_flow_codes WHERE authorized_user_id = ?`},
		// 播种的账号级工作区（Agent / backend / 执行目标 / 项目 / 项目路径）。
		{"sync_objects", `DELETE FROM sync_objects WHERE user_id = ?`},
		// 从 web 发起新对话时浏览器会自关注自己那条（R16），跑挂了也照删。
		{"followed_sessions", `DELETE FROM followed_sessions WHERE user_id = ?`},
		{"devices", `DELETE FROM devices WHERE user_id = ?`},
		{"user_identities", `DELETE FROM user_identities WHERE user_id = ?`},
		{"users", `DELETE FROM users WHERE id = ?`},
	}
	for _, step := range steps {
		res := gdb.Exec(step.sql, uid)
		if res.Error != nil {
			return fmt.Errorf("delete %s: %w", step.table, res.Error)
		}
		out.Deleted[step.table] = res.RowsAffected
	}
	// 浏览器 session 是 Redis 键;run 期间还可能留下 agentred 的中继在线态,
	// 那些带 TTL 自会过期,这里只清我们亲手写的那一把钥匙。
	if err := rc.Del(context.Background(), "session:"+sessionSID(*runID)).Err(); err != nil {
		return fmt.Errorf("delete browser session: %w", err)
	}

	counts := []struct {
		table string
		sql   string
	}{
		{"device_tokens", `SELECT count(*) FROM device_tokens WHERE device_id IN (SELECT id FROM devices WHERE user_id = ?)`},
		{"sync_objects", `SELECT count(*) FROM sync_objects WHERE user_id = ?`},
		{"followed_sessions", `SELECT count(*) FROM followed_sessions WHERE user_id = ?`},
		{"devices", `SELECT count(*) FROM devices WHERE user_id = ?`},
		{"users", `SELECT count(*) FROM users WHERE id = ?`},
	}
	for _, c := range counts {
		var n int64
		if err := gdb.Raw(c.sql, uid).Scan(&n).Error; err != nil {
			return fmt.Errorf("recount %s: %w", c.table, err)
		}
		out.Residue[c.table] = n
	}
	return emit(out)
}

func emit(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}
