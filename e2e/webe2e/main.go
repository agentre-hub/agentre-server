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
//   - one Redis browser session (sid → {user_id, csrf_token}) that becomes the
//     logged-in browser via the session cookie.
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

func sessionSID(runID string) string { return "webe2e-" + runID }

type agentredDevice struct {
	DeviceID     int64  `json:"device_id"`
	Fingerprint  string `json:"fingerprint"`
	RefreshToken string `json:"refresh_token"`
}

type browserSession struct {
	SID       string `json:"sid"`
	CSRFToken string `json:"csrf_token"`
}

type seedResult struct {
	RunID    string          `json:"run_id"`
	UserID   int64           `json:"user_id"`
	Email    string          `json:"email"`
	Agentred *agentredDevice `json:"agentred"`
	Session  browserSession  `json:"session"`
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
                  --run-id ID --agentred-fingerprint FP
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
		out.Agentred = &agentredDevice{Fingerprint: *agentredFP}
		if err := tx.Raw(
			`INSERT INTO devices (user_id, name, kind, platform, version, fingerprint, last_seen_at, status, createtime, updatetime)
			 VALUES (?, ?, 'agentred', 'darwin', 'e2e', ?, ?, 1, ?, ?) RETURNING id`,
			out.UserID, "webe2e-agentred", out.Agentred.Fingerprint, now, now, now,
		).Scan(&out.Agentred.DeviceID).Error; err != nil {
			return fmt.Errorf("insert agentred device: %w", err)
		}
		plain, err := randomToken()
		if err != nil {
			return err
		}
		out.Agentred.RefreshToken = plain
		// The server stores only sha256(refresh_token) (device_svc.sha256Hex);
		// seeding the hash lets the real agentred trade it for an access JWT
		// through the real POST /v1/oauth/token/refresh at startup.
		sum := sha256.Sum256([]byte(plain))
		if err := tx.Exec(
			`INSERT INTO device_tokens (device_id, access_jti, refresh_token_hash, refresh_expires_at, createtime)
			 VALUES (?, '', ?, ?, ?)`,
			out.Agentred.DeviceID, hex.EncodeToString(sum[:]), now+30*24*3600*1000, now,
		).Error; err != nil {
			return fmt.Errorf("insert agentred device token: %w", err)
		}
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
