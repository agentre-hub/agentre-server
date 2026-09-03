package release_svc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// DefaultBaseURL 是未配置下载源时问的上游：桌面端仓库的 GitHub releases/latest API。
// 内网部署把 Config.BaseURL 指到自己的镜像即可（决策 12）；这个包不关心镜像的形状，
// 只要求它应答同一个 {"tag_name": "..."} 形状。
const DefaultBaseURL = "https://api.github.com/repos/agentre-hub/agentre/releases/latest"

// githubUpstream 是 Upstream 的默认实现：GET baseURL，取应答里的 tag_name。
type githubUpstream struct {
	baseURL string
	http    *http.Client
}

// NewGithubUpstream 构造默认实现（10s timeout）。baseURL 为空时退回 DefaultBaseURL。
func NewGithubUpstream(baseURL string) Upstream {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	return &githubUpstream{baseURL: baseURL, http: &http.Client{Timeout: 10 * time.Second}}
}

func (u *githubUpstream) LatestVersion(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.baseURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := u.http.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("release upstream status %d", resp.StatusCode)
	}
	var body struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", err
	}
	version := strings.TrimPrefix(strings.TrimSpace(body.TagName), "v")
	if version == "" {
		return "", errors.New("release upstream: empty tag_name")
	}
	return version, nil
}
