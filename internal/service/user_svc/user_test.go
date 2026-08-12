package user_svc

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/cago-frame/cago/pkg/consts"
	"github.com/smartystreets/goconvey/convey"
	"github.com/stretchr/testify/assert"
	"go.uber.org/mock/gomock"

	"agentre-server/internal/model/entity/user_entity"
	"agentre-server/internal/model/entity/user_identity_entity"
	"agentre-server/internal/repository/user_identity_repo"
	"agentre-server/internal/repository/user_identity_repo/mock_user_identity_repo"
	"agentre-server/internal/repository/user_repo"
	"agentre-server/internal/repository/user_repo/mock_user_repo"
	hubtest "agentre-server/internal/testutils"
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
			mU.EXPECT().Find(gomock.Any(), int64(7)).
				Return(&user_entity.User{ID: 7, Status: consts.ACTIVE, Email: "a@b.com"}, nil)
			u, err := User().FindOrCreateFromGithub(ctx, GithubProfile{GithubID: "12345", Email: "a@b.com"})
			assert.NoError(t, err)
			assert.Equal(t, int64(7), u.ID)
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
