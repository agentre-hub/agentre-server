package main

import (
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

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
)

// accountEmail is the only handle a run has on its own rows. It embeds the run
// id so `cleanup` can find exactly this run's account and nothing else — the
// suite runs against a shared developer database, so every statement below is
// scoped by that one user id and there is no TRUNCATE anywhere in this file.
func accountEmail(runID string) string { return "synce2e-" + runID + "@e2e.invalid" }

type seededDevice struct {
	Name         string `json:"name"`
	Kind         string `json:"kind"`
	Platform     string `json:"platform"`
	DeviceID     int64  `json:"device_id"`
	Fingerprint  string `json:"fingerprint"`
	RefreshToken string `json:"refresh_token"`
}

type seedResult struct {
	RunID   string          `json:"run_id"`
	UserID  int64           `json:"user_id"`
	Email   string          `json:"email"`
	Devices []*seededDevice `json:"devices"`
}

func openDB(dsn string) (*gorm.DB, error) {
	if strings.TrimSpace(dsn) == "" {
		return nil, fmt.Errorf("--dsn is required (the harness reads it from github.com/agentre-hub/agentre-server/configs/config.yaml)")
	}
	gdb, err := gorm.Open(mysql.Open(dsn), &gorm.Config{Logger: gormlogger.Discard})
	if err != nil {
		// A dead database must be loud: the suite may not silently skip or pretend to pass.
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
	fs := flag.NewFlagSet("seed", flag.ExitOnError)
	dsn := fs.String("dsn", os.Getenv("SYNCE2E_DSN"), "MySQL DSN")
	runID := fs.String("run-id", "", "unique id for this run")
	devices := fs.String("devices", "", "comma separated name:kind:platform triples")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*runID) == "" {
		return fmt.Errorf("--run-id is required")
	}
	specs, err := parseDeviceSpecs(*devices)
	if err != nil {
		return err
	}
	gdb, err := openDB(*dsn)
	if err != nil {
		return err
	}

	now := time.Now().UnixMilli()
	out := &seedResult{RunID: *runID, Email: accountEmail(*runID)}
	err = gdb.Transaction(func(tx *gorm.DB) error {
		user := struct {
			ID          int64  `gorm:"column:id;primaryKey;autoIncrement"`
			Email       string `gorm:"column:email"`
			DisplayName string `gorm:"column:display_name"`
			AvatarURL   string `gorm:"column:avatar_url"`
			Status      int    `gorm:"column:status"`
			Createtime  int64  `gorm:"column:createtime"`
			Updatetime  int64  `gorm:"column:updatetime"`
		}{Email: out.Email, DisplayName: "synce2e " + *runID, Status: 1, Createtime: now, Updatetime: now}
		if err := tx.Table("users").Create(&user).Error; err != nil {
			return fmt.Errorf("insert user: %w", err)
		}
		out.UserID = user.ID
		for _, spec := range specs {
			dev := &seededDevice{
				Name:        spec.name,
				Kind:        spec.kind,
				Platform:    spec.platform,
				Fingerprint: fmt.Sprintf("synce2e-%s-%s", *runID, spec.name),
			}
			row := struct {
				ID          int64  `gorm:"column:id;primaryKey;autoIncrement"`
				UserID      int64  `gorm:"column:user_id"`
				Name        string `gorm:"column:name"`
				Kind        string `gorm:"column:kind"`
				Platform    string `gorm:"column:platform"`
				Version     string `gorm:"column:version"`
				Fingerprint string `gorm:"column:fingerprint"`
				LastSeenAt  int64  `gorm:"column:last_seen_at"`
				Status      int    `gorm:"column:status"`
				Createtime  int64  `gorm:"column:createtime"`
				Updatetime  int64  `gorm:"column:updatetime"`
			}{
				UserID: out.UserID, Name: dev.Name, Kind: dev.Kind, Platform: dev.Platform,
				Version: "e2e", Fingerprint: dev.Fingerprint, LastSeenAt: now,
				Status: 1, Createtime: now, Updatetime: now,
			}
			if err := tx.Table("devices").Create(&row).Error; err != nil {
				return fmt.Errorf("insert device %s: %w", spec.name, err)
			}
			dev.DeviceID = row.ID
			plain, err := randomToken()
			if err != nil {
				return err
			}
			dev.RefreshToken = plain
			// The server stores only sha256(refresh_token) (device_svc.sha256Hex); seeding the
			// hash is what lets a client trade this token for a real access JWT through the real
			// POST /v1/oauth/token/refresh — no JWT is minted here, no signing key is read.
			sum := sha256.Sum256([]byte(plain))
			if err := tx.Exec(
				`INSERT INTO device_tokens (device_id, access_jti, refresh_token_hash, refresh_expires_at, createtime)
				 VALUES (?, '', ?, ?, ?)`,
				dev.DeviceID, hex.EncodeToString(sum[:]), now+30*24*3600*1000, now,
			).Error; err != nil {
				return fmt.Errorf("insert device token %s: %w", spec.name, err)
			}
			out.Devices = append(out.Devices, dev)
		}
		return nil
	})
	if err != nil {
		return err
	}
	return emit(out)
}

type deviceSpec struct{ name, kind, platform string }

func parseDeviceSpecs(raw string) ([]deviceSpec, error) {
	var out []deviceSpec
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		bits := strings.Split(part, ":")
		if len(bits) != 3 || bits[0] == "" || bits[1] == "" {
			return nil, fmt.Errorf("bad --devices entry %q, want name:kind:platform", part)
		}
		out = append(out, deviceSpec{name: bits[0], kind: bits[1], platform: bits[2]})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("--devices must list at least one name:kind:platform triple")
	}
	return out, nil
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
	// Residue re-counts every table after the deletes: the suite asserts it is all zeros,
	// which is the only honest proof this run left the shared database as it found it.
	Residue map[string]int64 `json:"residue"`
}

func runCleanup(args []string) error {
	fs := flag.NewFlagSet("cleanup", flag.ExitOnError)
	dsn := fs.String("dsn", os.Getenv("SYNCE2E_DSN"), "MySQL DSN")
	runID := fs.String("run-id", "", "run id used at seed time")
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

	// device_tokens hangs off devices, so it goes before them; users last.
	steps := []struct {
		table string
		sql   string
	}{
		{"sync_objects", `DELETE FROM sync_objects WHERE user_id = ?`},
		{"sync_account_seqs", `DELETE FROM sync_account_seqs WHERE user_id = ?`},
		{"sync_device_states", `DELETE FROM sync_device_states WHERE user_id = ?`},
		{"sync_avatars", `DELETE FROM sync_avatars WHERE user_id = ?`},
		{"device_local_paths", `DELETE FROM device_local_paths WHERE user_id = ?`},
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

	counts := []struct {
		table string
		sql   string
	}{
		{"sync_objects", `SELECT count(*) FROM sync_objects WHERE user_id = ?`},
		{"sync_account_seqs", `SELECT count(*) FROM sync_account_seqs WHERE user_id = ?`},
		{"sync_device_states", `SELECT count(*) FROM sync_device_states WHERE user_id = ?`},
		{"sync_avatars", `SELECT count(*) FROM sync_avatars WHERE user_id = ?`},
		{"device_local_paths", `SELECT count(*) FROM device_local_paths WHERE user_id = ?`},
		{"device_tokens", `SELECT count(*) FROM device_tokens WHERE device_id IN (SELECT id FROM devices WHERE user_id = ?)`},
		{"device_flow_codes", `SELECT count(*) FROM device_flow_codes WHERE authorized_user_id = ?`},
		{"devices", `SELECT count(*) FROM devices WHERE user_id = ?`},
		{"user_identities", `SELECT count(*) FROM user_identities WHERE user_id = ?`},
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

type localPathRow struct {
	DeviceID      int64  `json:"device_id"      gorm:"column:device_id"`
	ProjectSyncID string `json:"project_sync_id" gorm:"column:project_sync_id"`
	Path          string `json:"path"           gorm:"column:path"`
}

// runLocalPaths is the server-side oracle for R16 / R18: what the account's
// device_local_paths namespace actually holds, per device.
func runLocalPaths(args []string) error {
	fs := flag.NewFlagSet("local-paths", flag.ExitOnError)
	dsn := fs.String("dsn", os.Getenv("SYNCE2E_DSN"), "MySQL DSN")
	runID := fs.String("run-id", "", "run id used at seed time")
	if err := fs.Parse(args); err != nil {
		return err
	}
	gdb, err := openDB(*dsn)
	if err != nil {
		return err
	}
	var uid int64
	if err := gdb.Raw(`SELECT id FROM users WHERE email = ?`, accountEmail(*runID)).Scan(&uid).Error; err != nil {
		return err
	}
	rows := []localPathRow{}
	if uid != 0 {
		if err := gdb.Raw(
			`SELECT device_id, project_sync_id, path FROM device_local_paths
			 WHERE user_id = ? ORDER BY device_id, project_sync_id`, uid,
		).Scan(&rows).Error; err != nil {
			return err
		}
	}
	return emit(map[string]any{"user_id": uid, "items": rows})
}

func emit(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}
