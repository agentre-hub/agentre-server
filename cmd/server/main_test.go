package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
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

func TestLoadConfigRejectsUnreadableExplicitFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "unreadable.yaml")
	if err := os.WriteFile(path, []byte(validConfig), 0o000); err != nil {
		t.Fatal(err)
	}

	_, err := loadConfig([]string{"--config", path})
	if err == nil {
		t.Fatal("loadConfig() succeeded with unreadable file")
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
