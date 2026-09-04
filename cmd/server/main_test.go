package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cago-frame/cago/database/db"

	"github.com/agentre-hub/agentre-server/internal/bootstrap"
)

const validConfig = "env: test\ndebug: false\nsource: file\n"

func TestLoadConfigUsesExplicitPathOnly(t *testing.T) {
	t.Chdir(t.TempDir())
	if err := os.MkdirAll("configs", 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile("configs/config.yaml", []byte(validConfig), 0o600); err != nil {
		t.Fatal(err)
	}

	explicitPath := filepath.Join(t.TempDir(), "missing.yaml")
	_, err := loadConfig([]string{"--config", explicitPath})
	if err == nil {
		t.Fatal("loadConfig() succeeded by falling back to configs/config.yaml")
	}
	if !strings.Contains(err.Error(), explicitPath) {
		t.Fatalf("loadConfig() error = %q, want explicit path %q", err, explicitPath)
	}
}

func TestLoadConfigReadsValidExplicitFile(t *testing.T) {
	t.Chdir(t.TempDir())
	if err := os.MkdirAll("configs", 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile("configs/config.yaml", []byte("env: ["), 0o600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "valid.yaml")
	if err := os.WriteFile(path, []byte(validConfig), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := loadConfig([]string{"--config", path}); err != nil {
		t.Fatalf("loadConfig() error = %v", err)
	}
}

func TestLoadConfigRejectsExplicitPathThatIsNotAFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}

	_, err := loadConfig([]string{"--config", path})
	if err == nil {
		t.Fatal("loadConfig() succeeded with a directory as the explicit file")
	}
	if !strings.Contains(err.Error(), path) {
		t.Fatalf("loadConfig() error = %q, want explicit path %q", err, path)
	}
}

func TestLoadConfigRejectsInvalidExplicitFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "invalid.yaml")
	if err := os.WriteFile(path, []byte("env: ["), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := loadConfig([]string{"--config", path})
	if err == nil {
		t.Fatal("loadConfig() succeeded with invalid YAML")
	}
	if !strings.Contains(err.Error(), path) {
		t.Fatalf("loadConfig() error = %q, want explicit path %q", err, path)
	}
}

func TestLoadConfigDefaultsToConfigsConfigYAML(t *testing.T) {
	t.Chdir(t.TempDir())
	if err := os.MkdirAll("configs", 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile("configs/config.yaml", []byte(validConfig), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := loadConfig(nil); err != nil {
		t.Fatalf("loadConfig() error = %v", err)
	}
}

// 覆盖层要在 loadConfig 装配配置源时接上：漏接这一步的话它根本不在链路上，
// 而两边的单测仍然全绿。
func TestLoadConfigAppliesDBDSNFromEnv(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	content := validConfig + "db:\n  driver: mysql\n  dsn: \"file:file@tcp(file:3306)/file\"\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(bootstrap.EnvDBDSN, "env:env@tcp(env:3306)/env")

	cfg, err := loadConfig([]string{"--config", path})
	if err != nil {
		t.Fatalf("loadConfig() error = %v", err)
	}

	var got db.Config
	if err := cfg.Scan(context.Background(), "db", &got); err != nil {
		t.Fatalf("Scan(db) error = %v", err)
	}
	if got.Dsn != "env:env@tcp(env:3306)/env" {
		t.Fatalf("db.dsn = %q, want the value from %s", got.Dsn, bootstrap.EnvDBDSN)
	}
	if got.Driver != "mysql" {
		t.Fatalf("db.driver = %q, want the value from the config file", got.Driver)
	}
}
