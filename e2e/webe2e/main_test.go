package main

import (
	"strings"
	"testing"
)

func TestSeedCreatesOnlyUserAndProductionSession(t *testing.T) {
	if got := seedTables(); len(got) != 1 || got[0] != "users" {
		t.Fatalf("seed tables = %v, want only users", got)
	}

	payload := newSessionPayload(42, "csrf", 1234)
	if payload.UserID != 42 || payload.CSRFToken != "csrf" || payload.CreatedAt != 1234 {
		t.Fatalf("session payload = %#v, want production user_id/csrf_token/created_at shape", payload)
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

func TestResiduePlanCoversPersistedStateAndSession(t *testing.T) {
	counts := residueSQL()
	for _, name := range []string{"users", "device_flow_codes", "devices", "device_tokens"} {
		_ = findSQLStep(t, counts, name)
	}
	if got := sessionKey("run-7"); got != "session:webe2e-run-7" {
		t.Fatalf("session key = %q", got)
	}

	residue := map[string]int64{"users": 0, "device_flow_codes": 1, "session": 0}
	if err := validateNoResidue(residue); err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("validateNoResidue error = %v, want count-only residue failure", err)
	}
}

func TestOracleReportsStateWithoutSecretColumns(t *testing.T) {
	if got := oracleIdentitySQL(); !strings.Contains(got, "id = ?") || !strings.Contains(got, "email = ?") {
		t.Fatalf("oracle identity query is not scoped by run and user: %s", got)
	}

	steps := oracleSQL()
	for _, name := range []string{"device_flow_codes", "devices", "device_tokens"} {
		step := findSQLStep(t, steps, name)
		lower := strings.ToLower(step.SQL)
		for _, secret := range []string{"device_code", "user_code", "access_jti", "refresh_token_hash"} {
			if strings.Contains(lower, secret) {
				t.Fatalf("oracle %s exposes secret column %s: %s", name, secret, step.SQL)
			}
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
