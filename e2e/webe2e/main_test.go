package main

import (
	"encoding/json"
	"strings"
	"testing"

	serversession "github.com/agentre-hub/agentre-server/internal/pkg/session"
)

func TestSeedCreatesOnlyUserAndProductionSession(t *testing.T) {
	if got := seedTables(); len(got) != 1 || got[0] != "users" {
		t.Fatalf("seed tables = %v, want only users", got)
	}

	payload := newSessionPayload(42, "csrf", 1234)
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
	steps := cleanupSQL()
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

	flow := findSQLStep(t, steps, "device_flow_codes")
	if !strings.Contains(flow.SQL, "authorized_user_id = ?") || !strings.Contains(flow.SQL, "client_fingerprint = ?") {
		t.Fatalf("flow cleanup must cover approved and pending rows for this run: %s", flow.SQL)
	}
	missingUserFlow := flowSelection(false)
	if strings.Contains(missingUserFlow.SQL, "authorized_user_id") || !strings.Contains(missingUserFlow.SQL, "client_fingerprint = ?") {
		t.Fatalf("missing-user cleanup could select another run's pending flows: %s", missingUserFlow.SQL)
	}
}

func TestResiduePlanCoversPersistedStateAndRunScopedRedisKeys(t *testing.T) {
	counts := residueSQL()
	for _, name := range []string{
		"users", "device_flow_codes", "devices", "device_tokens",
		"sync_objects", "sync_account_seqs", "sync_device_states", "sync_avatars", "device_local_paths",
		// 通行密钥的行没有指向 users 的外键：账号删掉它也留着，清理里不列一条就
		// 永久留在专库里（本轮已实证留下两行属于已删账号的凭证）。
		"webauthn_credentials",
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
	if got := oracleIdentitySQL(); !strings.Contains(got, "id = ?") || !strings.Contains(got, "email = ?") {
		t.Fatalf("oracle identity query is not scoped by run and user: %s", got)
	}

	steps := oracleSQL()
	for _, name := range []string{"device_flow_codes", "devices", "device_tokens", "sync_objects"} {
		step := findSQLStep(t, steps, name)
		lower := strings.ToLower(step.SQL)
		for _, secret := range []string{"device_code", "user_code", "access_jti", "refresh_token_hash"} {
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
