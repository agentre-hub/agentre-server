package main

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"

	serversession "github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/testutils"
)

// The seeded account must be in the state production account creation leaves it in
// (user_svc): the users row and its sync_account_seqs row, committed together. An
// account without that row takes NextVersion's fallback on its first allocation, and
// two concurrent runs' fresh accounts allocating in overlapping transactions can die
// with ERROR 1213 — a state production no longer produces.
func TestSeedAccountCreatesUserAndItsVersionSeqInOneTransaction(t *testing.T) {
	ctx, gdb, mock := testutils.Database(t)
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO `users`")).
		WillReturnResult(sqlmock.NewResult(42, 1))
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO sync_account_seqs")).
		WithArgs(int64(42), sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	id, err := seedAccount(ctx, gdb, "webe2e-run@e2e.invalid", "webe2e run", 1234)
	if err != nil {
		t.Fatalf("seedAccount: %v", err)
	}
	if id != 42 {
		t.Fatalf("seedAccount id = %d, want 42", id)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// When the seq row cannot be written the account must not survive without it.
func TestSeedAccountRollsBackUserWhenVersionSeqFails(t *testing.T) {
	ctx, gdb, mock := testutils.Database(t)
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO `users`")).
		WillReturnResult(sqlmock.NewResult(42, 1))
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO sync_account_seqs")).
		WillReturnError(errSeedBoom)
	mock.ExpectRollback()

	if _, err := seedAccount(ctx, gdb, "webe2e-run@e2e.invalid", "webe2e run", 1234); err == nil {
		t.Fatal("seedAccount succeeded, want the seq insert error")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// A failed session seed removes the account again; the seq row goes with it, otherwise
// cleanup (which finds the run by its user email) can never reach the orphan.
func TestUnseedAccountRemovesVersionSeqAndUser(t *testing.T) {
	ctx, gdb, mock := testutils.Database(t)
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM sync_account_seqs WHERE user_id = ?")).
		WithArgs(int64(42)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM users WHERE id = ?")).
		WithArgs(int64(42)).WillReturnResult(sqlmock.NewResult(0, 1))

	if err := unseedAccount(ctx, gdb, 42); err != nil {
		t.Fatalf("unseedAccount: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestSeedSessionUsesProductionSessionContract(t *testing.T) {
	payload := serversession.Session{UserID: 42, CSRFToken: "csrf", CreatedAt: 1234}
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal session payload: %v", err)
	}
	var decoded serversession.Session
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("decode fixture with production session contract: %v", err)
	}
	if decoded.UserID != 42 || decoded.CSRFToken != "csrf" || decoded.CreatedAt != 1234 {
		t.Fatalf("production session decoded fixture as %#v, want user 42 with matching csrf and creation time", decoded)
	}
}

func TestCleanupPlanIsRunScopedAndHasNoDangerousOperations(t *testing.T) {
	steps := make([]sqlStep, 0, len(fixtureTables()))
	for _, table := range fixtureTables() {
		if table.del != "" {
			steps = append(steps, sqlStep{Name: table.name, SQL: table.del})
		}
	}
	if len(steps) == 0 {
		t.Fatal("cleanup plan is empty")
	}
	for _, step := range steps {
		upper := strings.ToUpper(step.SQL)
		for _, dangerous := range []string{"TRUNCATE", "DROP DATABASE", "FLUSHDB", "FLUSHALL"} {
			if strings.Contains(upper, dangerous) {
				t.Fatalf("cleanup %s contains dangerous operation %s", step.Name, dangerous)
			}
		}
		if !strings.Contains(step.SQL, "?") {
			t.Fatalf("cleanup %s is not scoped by a bound run/user value: %s", step.Name, step.SQL)
		}
	}

	// device_flow_codes 的删除在 runCleanup 里按「账号找没找到」现拼，不在这张表清单里。
	flow := flowSelection(true)
	if !strings.Contains(flow, "authorized_user_id = ?") || !strings.Contains(flow, "client_fingerprint = ?") {
		t.Fatalf("flow cleanup must cover approved and pending rows for this run: %s", flow)
	}
	missingUserFlow := flowSelection(false)
	if strings.Contains(missingUserFlow, "authorized_user_id") || !strings.Contains(missingUserFlow, "client_fingerprint = ?") {
		t.Fatalf("missing-user cleanup could select another run's pending flows: %s", missingUserFlow)
	}
}

func TestResiduePlanCoversPersistedStateAndRunScopedRedisKeys(t *testing.T) {
	counts := make([]sqlStep, 0, len(fixtureTables())+1)
	for _, table := range fixtureTables() {
		if table.cnt != "" {
			counts = append(counts, sqlStep{Name: table.name, SQL: table.cnt})
		}
	}
	// device_flow_codes 的复点在 runCleanup 里按账号找没找到现拼，这里补上同一句。
	counts = append(counts, sqlStep{Name: "device_flow_codes", SQL: "SELECT count(*) FROM " + flowSelection(true)})
	for _, name := range []string{
		"users", "device_flow_codes", "devices", "device_tokens",
		"sync_objects", "sync_account_seqs", "sync_device_states", "sync_avatars", "device_local_paths",
		// 通行密钥的行没有指向 users 的外键：账号删掉它也留着，清理里不列一条就
		// 永久留在专库里（本轮已实证留下两行属于已删账号的凭证）。
		"webauthn_credentials",
		// port_forward_links 同样没有指向 users 的外键（迁移 202609210101 只用裸
		// bigint），账号删掉它也留着——2026-09-22 已实证一轮 run 留下 5 行残留。
		"port_forward_links",
	} {
		_ = findSQLStep(t, counts, name)
	}
	got := redisKeys("run-7")
	other := redisKeys("run-8")
	if len(got) != 2 || got[0] != "session:webe2e-run-7" || !strings.HasPrefix(got[1], "rl:authz:198.18.") {
		t.Fatalf("redis keys = %q, want isolated session and reserved authorize limiter keys", got)
	}
	if got[1] == other[1] {
		t.Fatalf("different runs share authorize limiter key %q", got[1])
	}

	residue := map[string]int64{"users": 0, "device_flow_codes": 1, "session": 0, "rate_limit": 0}
	if err := validateNoResidue(residue); err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("validateNoResidue error = %v, want count-only residue failure", err)
	}
}

func TestOracleReportsStateWithoutSecretColumns(t *testing.T) {
	if got := oracleIdentityQuery; !strings.Contains(got, "id = ?") || !strings.Contains(got, "email = ?") {
		t.Fatalf("oracle identity query is not scoped by run and user: %s", got)
	}

	steps := []sqlStep{
		{"device_flow_codes", oracleFlowsQuery},
		{"devices", oracleDevicesQuery},
		{"device_tokens", oracleTokensQuery},
		{"sync_objects", oracleSyncObjectsQuery},
	}
	for _, name := range []string{"device_flow_codes", "devices", "device_tokens", "sync_objects"} {
		step := findSQLStep(t, steps, name)
		lower := strings.ToLower(step.SQL)
		for _, secret := range []string{"device_code", "user_code", "access_token_hash", "refresh_token_hash"} {
			if strings.Contains(lower, secret) {
				t.Fatalf("oracle %s exposes secret column %s: %s", name, secret, step.SQL)
			}
		}
	}

	syncObjects := findSQLStep(t, steps, "sync_objects")
	for _, column := range []string{"sync_id", "kind", "version", "deleted_at"} {
		if !strings.Contains(strings.ToLower(syncObjects.SQL), column) {
			t.Fatalf("oracle sync_objects does not report %s: %s", column, syncObjects.SQL)
		}
	}
}

var errSeedBoom = sqlmock.ErrCancelled

func findSQLStep(t *testing.T, steps []sqlStep, name string) sqlStep {
	t.Helper()
	for _, step := range steps {
		if step.Name == name {
			return step
		}
	}
	t.Fatalf("missing SQL step %q in %#v", name, steps)
	return sqlStep{}
}
