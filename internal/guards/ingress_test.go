package guards_test

import (
	"os"
	"path/filepath"
	"testing"

	"gopkg.in/yaml.v3"
)

// TestDefaultIngressTimeoutAnnotations 断言长连接超时由 Chart 默认值明确持有，
// 避免部署行为意外回退到各集群不同的 Ingress Controller 默认配置。
func TestDefaultIngressTimeoutAnnotations(t *testing.T) {
	const wantTimeout = "3600"

	raw, err := os.ReadFile(filepath.Join(repoRoot(t), "deploy", "helm", "values.yaml"))
	if err != nil {
		t.Fatalf("read Helm values: %v", err)
	}

	var values struct {
		Ingress struct {
			Annotations map[string]any `yaml:"annotations"`
		} `yaml:"ingress"`
	}
	if err := yaml.Unmarshal(raw, &values); err != nil {
		t.Fatalf("parse Helm values: %v", err)
	}

	for _, name := range []string{
		"nginx.ingress.kubernetes.io/proxy-read-timeout",
		"nginx.ingress.kubernetes.io/proxy-send-timeout",
	} {
		t.Run(name, func(t *testing.T) {
			got, ok := values.Ingress.Annotations[name]
			if !ok {
				t.Fatalf("ingress.annotations 缺少 %q", name)
			}
			if got != wantTimeout {
				t.Fatalf("ingress.annotations[%q] = %#v，必须是字符串 %q", name, got, wantTimeout)
			}
		})
	}
}
