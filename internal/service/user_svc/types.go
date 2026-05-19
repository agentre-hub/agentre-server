package user_svc

// GithubProfile 从 GitHub OAuth 拉到的最小 user 信息。
type GithubProfile struct {
	GithubID    string // /user.id 字符串化
	Login       string // GitHub username
	DisplayName string // /user.name，可空
	Email       string // primary verified email
	AvatarURL   string
	RawProfile  []byte // 原始 /user JSON，存 user_identities.raw_profile
}
