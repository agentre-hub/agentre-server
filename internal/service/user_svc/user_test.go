package user_svc

import (
	"context"
	"errors"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/cago-frame/cago/pkg/consts"
	"github.com/smartystreets/goconvey/convey"
	"github.com/stretchr/testify/assert"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/user_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/user_identity_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/user_identity_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_identity_repo/mock_user_identity_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo/mock_user_repo"
	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

func setupUserTest(t *testing.T) (context.Context, *mock_user_repo.MockUserRepo, *mock_user_identity_repo.MockUserIdentityRepo, sqlmock.Sqlmock) {
	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)
	mU := mock_user_repo.NewMockUserRepo(ctrl)
	mI := mock_user_identity_repo.NewMockUserIdentityRepo(ctrl)
	user_repo.RegisterUser(mU)
	user_identity_repo.RegisterUserIdentity(mI)
	ctx, _, mock := hubtest.Database(t)
	return ctx, mU, mI, mock
}

func TestFindOrCreateFromGithub(t *testing.T) {
	convey.Convey("FindOrCreateFromGithub", t, func() {
		convey.Convey("provider_uid 命中 → 直接登录", func() {
			ctx, mU, mI, _ := setupUserTest(t)
			mI.EXPECT().FindByProviderUID(gomock.Any(), "github", "12345").
				Return(&user_identity_entity.UserIdentity{UserID: 7}, nil)
			mU.EXPECT().FindIgnoreStatus(gomock.Any(), int64(7)).
				Return(&user_entity.User{ID: 7, Status: consts.ACTIVE, Email: "a@b.com"}, nil)
			u, err := User().FindOrCreateFromGithub(ctx, GithubProfile{GithubID: "12345", Email: "a@b.com"})
			assert.NoError(t, err)
			assert.Equal(t, int64(7), u.ID)
		})

		convey.Convey("provider_uid 命中但账号已被封禁 → 必须返回错误，不能是 (nil, nil)", func() {
			// 回归测试：user_repo.Find 的 WHERE 带 status=ACTIVE，封禁行查不出来、
			// 返回 (nil, nil)。FindOrCreateFromGithub 在 identity 已存在的路径上原本把它
			// 原样透传，auth_ctr.GithubCallback 随后对 (nil, nil) 里的 nil 解引用
			// u.ID，必然空指针。这里钉住「不能是 (nil, nil)」这个可观察结果：账号行本身
			// 存在但被封禁，闸门（user_entity.Check）判定后必须带一个可辨认的错误。
			ctx, mU, mI, _ := setupUserTest(t)
			mI.EXPECT().FindByProviderUID(gomock.Any(), "github", "12345").
				Return(&user_identity_entity.UserIdentity{UserID: 7}, nil)
			mU.EXPECT().FindIgnoreStatus(gomock.Any(), int64(7)).
				Return(&user_entity.User{ID: 7, Status: consts.BAN, Email: "a@b.com"}, nil)
			u, err := User().FindOrCreateFromGithub(ctx, GithubProfile{GithubID: "12345", Email: "a@b.com"})
			assert.Error(t, err, "被封账号必须带错误返回，否则调用方会对 nil 用户解引用 u.ID")
			assert.Nil(t, u)
		})

		convey.Convey("provider 未命中但 email 已存在 → 绑定新 identity", func() {
			ctx, mU, mI, _ := setupUserTest(t)
			mI.EXPECT().FindByProviderUID(gomock.Any(), "github", "12345").Return(nil, nil)
			mU.EXPECT().FindByEmail(gomock.Any(), "a@b.com").
				Return(&user_entity.User{ID: 9, Status: consts.ACTIVE, Email: "a@b.com"}, nil)
			mI.EXPECT().Create(gomock.Any(), gomock.Any()).Return(nil)
			u, err := User().FindOrCreateFromGithub(ctx, GithubProfile{GithubID: "12345", Email: "a@b.com"})
			assert.NoError(t, err)
			assert.Equal(t, int64(9), u.ID)
		})

		convey.Convey("全新用户 → 新建 user + identity", func() {
			ctx, mU, mI, mock := setupUserTest(t)
			mI.EXPECT().FindByProviderUID(gomock.Any(), "github", "12345").Return(nil, nil)
			mU.EXPECT().FindByEmail(gomock.Any(), "a@b.com").Return(nil, nil)
			mU.EXPECT().Create(gomock.Any(), gomock.Any()).
				DoAndReturn(func(_ context.Context, u *user_entity.User) error { u.ID = 100; return nil })
			mI.EXPECT().Create(gomock.Any(), gomock.Any()).Return(nil)
			mock.ExpectBegin()
			mock.ExpectCommit()
			u, err := User().FindOrCreateFromGithub(ctx, GithubProfile{
				GithubID: "12345", Email: "a@b.com", Login: "alice", DisplayName: "Alice",
			})
			assert.NoError(t, err)
			assert.Equal(t, int64(100), u.ID)
			assert.Equal(t, "Alice", u.DisplayName)
			assert.NoError(t, mock.ExpectationsWereMet())
		})
	})
}

// GithubLogin 把「这个账号绑的是哪个 GitHub 账号」从 auth_ctr 挪进服务层：控制器
// 原先直接调 user_identity_repo，越过了 service（依赖方向是
// controller → service → repository）。
func TestGithubLogin(t *testing.T) {
	t.Run("绑过就回它的登录名", func(t *testing.T) {
		ctx, _, mI, _ := setupUserTest(t)
		mI.EXPECT().FindByUserAndProvider(gomock.Any(), int64(7), user_identity_entity.ProviderGithub).
			Return(&user_identity_entity.UserIdentity{UserID: 7, ProviderLogin: "octocat"}, nil)

		login, err := User().GithubLogin(ctx, 7)

		assert.NoError(t, err)
		assert.Equal(t, "octocat", login)
	})

	// 没绑 GitHub 是常态（通行密钥注册的账号），不是错误：/me 照常返回，
	// github_login 留空。
	t.Run("没绑过回空串且不报错", func(t *testing.T) {
		ctx, _, mI, _ := setupUserTest(t)
		mI.EXPECT().FindByUserAndProvider(gomock.Any(), int64(7), user_identity_entity.ProviderGithub).
			Return(nil, nil)

		login, err := User().GithubLogin(ctx, 7)

		assert.NoError(t, err)
		assert.Empty(t, login)
	})

	// 查库真出错时如实上抛，由调用方决定要不要吞。auth_ctr 的 /me 选择吞掉它——
	// 一个附属字段读不到不该让整个 /me 挂掉——但那是调用方的决定，不是这里的。
	t.Run("查库出错如实上抛", func(t *testing.T) {
		ctx, _, mI, _ := setupUserTest(t)
		boom := errors.New("connection refused")
		mI.EXPECT().FindByUserAndProvider(gomock.Any(), int64(7), user_identity_entity.ProviderGithub).
			Return(nil, boom)

		login, err := User().GithubLogin(ctx, 7)

		assert.ErrorIs(t, err, boom)
		assert.Empty(t, login)
	})
}
