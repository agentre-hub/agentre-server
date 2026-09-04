// Command webe2e creates and removes the minimum authentication fixture needed
// by the real-browser E2E track. Every row and Redis key is scoped to one run.
package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	goredis "github.com/redis/go-redis/v9"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"

	serversession "github.com/agentre-hub/agentre-server/internal/pkg/session"
)

func accountEmail(runID string) string { return "webe2e-" + runID + "@e2e.invalid" }
func sessionSID(runID string) string   { return "webe2e-" + runID }

func rateLimitClientIP(runID string) string {
	sum := sha256.Sum256([]byte(runID))
	return fmt.Sprintf("198.18.%d.%d", sum[0], sum[1])
}

func redisKeys(runID string) []string {
	return []string{"session:" + sessionSID(runID), "rl:authz:" + rateLimitClientIP(runID)}
}

// flowFingerprint is the non-secret run handle that the browser must send to
// the device authorize endpoint. It lets cleanup find even an unapproved flow.
func flowFingerprint(runID string) string { return "webe2e-flow-" + runID }

type browserSession struct {
	SID       string `json:"sid"`
	CSRFToken string `json:"csrf_token"`
}

func newSessionPayload(userID int64, csrf string, createdAt int64) serversession.Session {
	return serversession.Session{UserID: userID, CSRFToken: csrf, CreatedAt: createdAt}
}

type seedResult struct {
	RunID           string         `json:"run_id"`
	UserID          int64          `json:"user_id"`
	Email           string         `json:"email"`
	FlowFingerprint string         `json:"flow_fingerprint"`
	BrowserSession  browserSession `json:"session"`
}

type sqlStep struct {
	Name string
	SQL  string
}

func seedTables() []string { return []string{"users"} }

func flowSelection(userFound bool) sqlStep {
	if !userFound {
		return sqlStep{"device_flow_codes", `device_flow_codes WHERE client_fingerprint = ?`}
	}
	return sqlStep{"device_flow_codes", `device_flow_codes WHERE authorized_user_id = ? OR client_fingerprint = ?`}
}

func cleanupSQL() []sqlStep {
	return []sqlStep{
		{"device_tokens", `DELETE FROM device_tokens WHERE device_id IN (SELECT id FROM devices WHERE user_id = ?)`},
		{"device_flow_codes", `DELETE FROM ` + flowSelection(true).SQL},
		{"device_local_paths", `DELETE FROM device_local_paths WHERE user_id = ?`},
		{"sync_device_states", `DELETE FROM sync_device_states WHERE user_id = ?`},
		{"sync_avatars", `DELETE FROM sync_avatars WHERE user_id = ?`},
		{"sync_objects", `DELETE FROM sync_objects WHERE user_id = ?`},
		{"sync_account_seqs", `DELETE FROM sync_account_seqs WHERE user_id = ?`},
		{"agent_session_saves", `DELETE FROM agent_session_saves WHERE user_id = ?`},
		// 通行密钥：webauthn_credentials 没有指向 users 的外键（迁移
		// 202608180002 刻意不建），删账号不会带走它。不在这里删一次，凭证行就永久
		// 留在专库里，账号却已经不存在了。
		{"webauthn_credentials", `DELETE FROM webauthn_credentials WHERE user_id = ?`},
		{"devices", `DELETE FROM devices WHERE user_id = ?`},
		{"user_identities", `DELETE FROM user_identities WHERE user_id = ?`},
		{"users", `DELETE FROM users WHERE id = ?`},
	}
}

func residueSQL() []sqlStep {
	return []sqlStep{
		{"device_tokens", `SELECT count(*) FROM device_tokens WHERE device_id IN (?)`},
		{"device_flow_codes", `SELECT count(*) FROM ` + flowSelection(true).SQL},
		{"device_local_paths", `SELECT count(*) FROM device_local_paths WHERE user_id = ?`},
		{"sync_device_states", `SELECT count(*) FROM sync_device_states WHERE user_id = ?`},
		{"sync_avatars", `SELECT count(*) FROM sync_avatars WHERE user_id = ?`},
		{"sync_objects", `SELECT count(*) FROM sync_objects WHERE user_id = ?`},
		{"sync_account_seqs", `SELECT count(*) FROM sync_account_seqs WHERE user_id = ?`},
		{"agent_session_saves", `SELECT count(*) FROM agent_session_saves WHERE user_id = ?`},
		{"webauthn_credentials", `SELECT count(*) FROM webauthn_credentials WHERE user_id = ?`},
		{"devices", `SELECT count(*) FROM devices WHERE user_id = ?`},
		{"user_identities", `SELECT count(*) FROM user_identities WHERE user_id = ?`},
		{"users", `SELECT count(*) FROM users WHERE id = ?`},
	}
}

// Oracle queries deliberately select state only. Bearer codes, token hashes,
// JTIs, cookies, and CSRF values cannot enter its JSON output.
func oracleIdentitySQL() string { return `SELECT count(*) FROM users WHERE id = ? AND email = ?` }

func oracleSQL() []sqlStep {
	return []sqlStep{
		{"device_flow_codes", `SELECT device_kind, authorized_user_id, approved_at, consumed_at, denied_at, expires_at FROM device_flow_codes WHERE authorized_user_id = ? OR client_fingerprint = ?`},
		{"devices", `SELECT id, kind, status FROM devices WHERE user_id = ?`},
		{"device_tokens", `SELECT dt.device_id, dt.refresh_expires_at, dt.last_used_at, dt.revoked_at FROM device_tokens dt JOIN devices d ON d.id = dt.device_id WHERE d.user_id = ?`},
		{"sync_objects", `SELECT sync_id, kind, version, deleted_at FROM sync_objects WHERE user_id = ? ORDER BY kind, sync_id`},
	}
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
	case "oracle":
		err = runOracle(os.Args[2:])
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
	fmt.Fprint(os.Stderr, `webe2e — isolated real-storage E2E fixture

  webe2e seed    --dsn DSN --redis-addr HOST:PORT [--redis-password PW --redis-db N] --run-id ID
  webe2e cleanup --dsn DSN --redis-addr HOST:PORT [--redis-password PW --redis-db N] --run-id ID
  webe2e oracle  --dsn DSN --run-id ID --user-id ID
`)
}

func registerRedisFlags(fs *flag.FlagSet) (*string, *string, *int) {
	addr := fs.String("redis-addr", os.Getenv("WEBE2E_REDIS_ADDR"), "Redis host:port")
	password := fs.String("redis-password", os.Getenv("WEBE2E_REDIS_PASSWORD"), "Redis password")
	db := fs.Int("redis-db", 0, "Redis db number")
	return addr, password, db
}

func openDB(dsn string) (*gorm.DB, error) {
	if strings.TrimSpace(dsn) == "" {
		return nil, fmt.Errorf("--dsn is required")
	}
	gdb, err := gorm.Open(mysql.Open(dsn), &gorm.Config{Logger: gormlogger.Discard})
	if err != nil {
		return nil, fmt.Errorf("connect mysql: %w", err)
	}
	sqlDB, err := gdb.DB()
	if err != nil {
		return nil, err
	}
	if err := sqlDB.Ping(); err != nil {
		return nil, fmt.Errorf("ping mysql: %w", err)
	}
	return gdb, nil
}

func runSeed(args []string) error {
	fs := flag.NewFlagSet("seed", flag.ContinueOnError)
	dsn := fs.String("dsn", os.Getenv("WEBE2E_DSN"), "MySQL DSN")
	runID := fs.String("run-id", "", "unique id for this run")
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
	rc := goredis.NewClient(&goredis.Options{Addr: *redisAddr, Password: *redisPassword, DB: *redisDB})
	defer func() { _ = rc.Close() }()
	if err := rc.Ping(context.Background()).Err(); err != nil {
		return fmt.Errorf("ping redis: %w", err)
	}

	now := time.Now().UnixMilli()
	out := &seedResult{RunID: *runID, Email: accountEmail(*runID), FlowFingerprint: flowFingerprint(*runID)}
	user := struct {
		ID          int64  `gorm:"column:id;primaryKey;autoIncrement"`
		Email       string `gorm:"column:email"`
		DisplayName string `gorm:"column:display_name"`
		AvatarURL   string `gorm:"column:avatar_url"`
		Status      int    `gorm:"column:status"`
		Createtime  int64  `gorm:"column:createtime"`
		Updatetime  int64  `gorm:"column:updatetime"`
	}{Email: out.Email, DisplayName: "webe2e " + *runID, Status: 1, Createtime: now, Updatetime: now}
	if err := gdb.Table("users").Create(&user).Error; err != nil {
		return fmt.Errorf("insert user: %w", err)
	}
	out.UserID = user.ID

	csrf, err := randomToken()
	if err != nil {
		return err
	}
	out.BrowserSession = browserSession{SID: sessionSID(*runID), CSRFToken: csrf}
	body, err := json.Marshal(newSessionPayload(out.UserID, csrf, now))
	if err != nil {
		return err
	}
	const sessionTTL = 14 * 24 * time.Hour
	if err := rc.Set(context.Background(), redisKeys(*runID)[0], body, sessionTTL).Err(); err != nil {
		_ = gdb.Exec(`DELETE FROM users WHERE id = ?`, out.UserID).Error
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
	fs := flag.NewFlagSet("cleanup", flag.ContinueOnError)
	dsn := fs.String("dsn", os.Getenv("WEBE2E_DSN"), "MySQL DSN")
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
	rc := goredis.NewClient(&goredis.Options{Addr: *redisAddr, Password: *redisPassword, DB: *redisDB})
	defer func() { _ = rc.Close() }()
	if err := rc.Ping(context.Background()).Err(); err != nil {
		return fmt.Errorf("ping redis: %w", err)
	}

	out := &cleanupResult{RunID: *runID, Deleted: map[string]int64{}, Residue: map[string]int64{}}
	var ids []int64
	if err := gdb.Raw(`SELECT id FROM users WHERE email = ?`, accountEmail(*runID)).Scan(&ids).Error; err != nil {
		return fmt.Errorf("find run user: %w", err)
	}
	if len(ids) > 1 {
		return fmt.Errorf("run has %d users; refusing ambiguous cleanup", len(ids))
	}
	var deviceIDs []int64
	if len(ids) == 1 {
		out.Found, out.UserID = true, ids[0]
		if err := gdb.Raw(`SELECT id FROM devices WHERE user_id = ?`, out.UserID).Scan(&deviceIDs).Error; err != nil {
			return fmt.Errorf("find run devices: %w", err)
		}
	}

	for _, step := range cleanupSQL() {
		var res *gorm.DB
		switch step.Name {
		case "device_flow_codes":
			selection := flowSelection(out.Found)
			if out.Found {
				res = gdb.Exec("DELETE FROM "+selection.SQL, out.UserID, flowFingerprint(*runID))
			} else {
				res = gdb.Exec("DELETE FROM "+selection.SQL, flowFingerprint(*runID))
			}
		default:
			if !out.Found {
				continue
			}
			res = gdb.Exec(step.SQL, out.UserID)
		}
		if res.Error != nil {
			return fmt.Errorf("delete %s: %w", step.Name, res.Error)
		}
		out.Deleted[step.Name] = res.RowsAffected
	}
	if err := rc.Del(context.Background(), redisKeys(*runID)...).Err(); err != nil {
		return fmt.Errorf("delete run redis keys: %w", err)
	}

	for _, step := range residueSQL() {
		var n int64
		var query *gorm.DB
		switch step.Name {
		case "device_tokens":
			if len(deviceIDs) == 0 {
				out.Residue[step.Name] = 0
				continue
			}
			query = gdb.Raw(step.SQL, deviceIDs)
		case "device_flow_codes":
			selection := flowSelection(out.Found)
			if out.Found {
				query = gdb.Raw("SELECT count(*) FROM "+selection.SQL, out.UserID, flowFingerprint(*runID))
			} else {
				query = gdb.Raw("SELECT count(*) FROM "+selection.SQL, flowFingerprint(*runID))
			}
		default:
			if !out.Found {
				out.Residue[step.Name] = 0
				continue
			}
			query = gdb.Raw(step.SQL, out.UserID)
		}
		if err := query.Scan(&n).Error; err != nil {
			return fmt.Errorf("recount %s: %w", step.Name, err)
		}
		out.Residue[step.Name] = n
	}
	keys := redisKeys(*runID)
	for i, name := range []string{"session", "rate_limit"} {
		exists, err := rc.Exists(context.Background(), keys[i]).Result()
		if err != nil {
			return fmt.Errorf("recount %s: %w", name, err)
		}
		out.Residue[name] = exists
	}
	if err := emit(out); err != nil {
		return err
	}
	return validateNoResidue(out.Residue)
}

func validateNoResidue(residue map[string]int64) error {
	var names []string
	for name, count := range residue {
		if count > 0 {
			names = append(names, fmt.Sprintf("%s=%d", name, count))
		}
	}
	if len(names) == 0 {
		return nil
	}
	sort.Strings(names)
	return fmt.Errorf("run residue remains: %s", strings.Join(names, ", "))
}

type flowState struct {
	DeviceKind       string `json:"device_kind"`
	AuthorizedUserID int64  `json:"authorized_user_id"`
	ApprovedAt       int64  `json:"approved_at"`
	ConsumedAt       int64  `json:"consumed_at"`
	DeniedAt         int64  `json:"denied_at"`
	ExpiresAt        int64  `json:"expires_at"`
}

type deviceState struct {
	ID     int64  `json:"id"`
	Kind   string `json:"kind"`
	Status int    `json:"status"`
}

type tokenState struct {
	DeviceID         int64 `json:"device_id"`
	RefreshExpiresAt int64 `json:"refresh_expires_at"`
	LastUsedAt       int64 `json:"last_used_at"`
	RevokedAt        int64 `json:"revoked_at"`
}

type syncObjectState struct {
	SyncID    string `json:"sync_id"`
	Kind      string `json:"kind"`
	Version   int64  `json:"version"`
	DeletedAt int64  `json:"deleted_at"`
}

type oracleResult struct {
	RunID       string            `json:"run_id"`
	UserID      int64             `json:"user_id"`
	Flows       []flowState       `json:"flows"`
	Devices     []deviceState     `json:"devices"`
	Tokens      []tokenState      `json:"tokens"`
	SyncObjects []syncObjectState `json:"sync_objects"`
}

func runOracle(args []string) error {
	fs := flag.NewFlagSet("oracle", flag.ContinueOnError)
	dsn := fs.String("dsn", os.Getenv("WEBE2E_DSN"), "MySQL DSN")
	runID := fs.String("run-id", "", "run id used at seed time")
	userID := fs.Int64("user-id", 0, "isolated run user id")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*runID) == "" || *userID <= 0 {
		return fmt.Errorf("--run-id and positive --user-id are required")
	}
	gdb, err := openDB(*dsn)
	if err != nil {
		return err
	}
	var users int64
	if err := gdb.Raw(oracleIdentitySQL(), *userID, accountEmail(*runID)).Scan(&users).Error; err != nil {
		return fmt.Errorf("verify oracle run user: %w", err)
	}
	if users != 1 {
		return fmt.Errorf("run user not found")
	}
	out := oracleResult{RunID: *runID, UserID: *userID, Flows: []flowState{}, Devices: []deviceState{}, Tokens: []tokenState{}, SyncObjects: []syncObjectState{}}
	steps := oracleSQL()
	if err := gdb.Raw(steps[0].SQL, *userID, flowFingerprint(*runID)).Scan(&out.Flows).Error; err != nil {
		return fmt.Errorf("query device flow state: %w", err)
	}
	if err := gdb.Raw(steps[1].SQL, *userID).Scan(&out.Devices).Error; err != nil {
		return fmt.Errorf("query device state: %w", err)
	}
	if err := gdb.Raw(steps[2].SQL, *userID).Scan(&out.Tokens).Error; err != nil {
		return fmt.Errorf("query token state: %w", err)
	}
	if err := gdb.Raw(steps[3].SQL, *userID).Scan(&out.SyncObjects).Error; err != nil {
		return fmt.Errorf("query sync object state: %w", err)
	}
	return emit(out)
}

func emit(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}
