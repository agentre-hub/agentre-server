package user_svc

import (
	"context"
	"errors"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/cago-frame/cago/pkg/consts"
	"github.com/go-sql-driver/mysql"
	"github.com/smartystreets/goconvey/convey"
	"github.com/stretchr/testify/assert"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/user_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/user_identity_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/dberr"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo/mock_sync_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_identity_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_identity_repo/mock_user_identity_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo/mock_user_repo"
	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

// dupKeyErr 造一个撞 index 这个唯一键的 1062，形状与 MySQL 8 的错误文本一致
// （internal/pkg/dberr 只认这一种/及不带表名前缀的那种）。
func dupKeyErr(table, index string) *mysql.MySQLError {
	return &mysql.MySQLError{
		Number:  1062,
		Message: "Duplicate entry 'x' for key '" + table + "." + index + "'",
	}
}

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

// registerSyncStateMock 注册 seq 仓储替身：全新建号在事务里要预建账号的 seq 行。
func registerSyncStateMock(t *testing.T) *mock_sync_repo.MockSyncStateRepo {
	t.Helper()
	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)
	m := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncState(m)
	t.Cleanup(func() { sync_repo.RegisterSyncState(nil) })
	return m
}

// setupUserTxTest 与 setupUserTest 装配同样的账号仓储替身，另加 seq 仓储替身，并换成
// hubtest.TxDatabase 交回事务事件记录：「user 行与 seq 行落在同一个建号事务里」只有
// 那份时序说得清。
func setupUserTxTest(t *testing.T) (
	context.Context, *hubtest.TxLog,
	*mock_user_repo.MockUserRepo, *mock_user_identity_repo.MockUserIdentityRepo, *mock_sync_repo.MockSyncStateRepo,
) {
	t.Helper()
	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)
	mU := mock_user_repo.NewMockUserRepo(ctrl)
	mI := mock_user_identity_repo.NewMockUserIdentityRepo(ctrl)
	user_repo.RegisterUser(mU)
	user_identity_repo.RegisterUserIdentity(mI)
	mS := registerSyncStateMock(t)
	ctx, txLog := hubtest.TxDatabase(t)
	return ctx, txLog, mU, mI, mS
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
			mS := registerSyncStateMock(t)
			mI.EXPECT().FindByProviderUID(gomock.Any(), "github", "12345").Return(nil, nil)
			mU.EXPECT().FindByEmail(gomock.Any(), "a@b.com").Return(nil, nil)
			mU.EXPECT().Create(gomock.Any(), gomock.Any()).
				DoAndReturn(func(_ context.Context, u *user_entity.User) error { u.ID = 100; return nil })
			mS.EXPECT().EnsureSeq(gomock.Any(), int64(100)).Return(nil)
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

		// 要求 18：新账号建好时它的 sync_account_seqs 行已经在了。两个都还没有 seq 行的
		// 新账号在重叠事务里首次取号，NextVersion 的空 UPDATE 各持一把间隙锁、随后的
		// INSERT 互等，其中一个 ERROR 1213（真库复现）。行由建号预建，首次取号就走命中
		// 本行的普通 UPDATE。它必须落在建号的**同一个**事务里：否则建号回滚会留下孤儿
		// seq 行，预建失败又会留下一个没有 seq 行的账号。
		convey.Convey("全新用户 → seq 行紧随 user 行在同一个建号事务里预建", func() {
			ctx, txLog, mU, mI, mS := setupUserTxTest(t)
			mI.EXPECT().FindByProviderUID(gomock.Any(), "github", "12345").Return(nil, nil)
			mU.EXPECT().FindByEmail(gomock.Any(), "a@b.com").Return(nil, nil)
			gomock.InOrder(
				mU.EXPECT().Create(gomock.Any(), gomock.Any()).
					DoAndReturn(func(_ context.Context, u *user_entity.User) error { u.ID = 100; return nil }),
				mS.EXPECT().EnsureSeq(gomock.Any(), int64(100)).
					DoAndReturn(func(ctx context.Context, _ int64) error {
						assert.True(t, hubtest.InTransaction(ctx), "seq 行必须随建号事务提交或回滚")
						return nil
					}),
			)
			mI.EXPECT().Create(gomock.Any(), gomock.Any()).Return(nil)

			u, err := User().FindOrCreateFromGithub(ctx, GithubProfile{GithubID: "12345", Email: "a@b.com"})

			assert.NoError(t, err)
			assert.Equal(t, int64(100), u.ID)
			assert.Equal(t, []string{hubtest.TxBegin, hubtest.TxCommit}, txLog.Events())
		})

		// 边界：预建失败就不能留下一个没有 seq 行的账号——整个建号回滚、错误原样上抛
		// （不是那两个可重查的唯一键，不重查），identity 也不再去建。
		convey.Convey("预建 seq 行失败 → 建号整体回滚并报错", func() {
			ctx, txLog, mU, mI, mS := setupUserTxTest(t)
			mI.EXPECT().FindByProviderUID(gomock.Any(), "github", "12345").Return(nil, nil)
			mU.EXPECT().FindByEmail(gomock.Any(), "a@b.com").Return(nil, nil)
			mU.EXPECT().Create(gomock.Any(), gomock.Any()).
				DoAndReturn(func(_ context.Context, u *user_entity.User) error { u.ID = 100; return nil })
			boom := errors.New("connection refused")
			mS.EXPECT().EnsureSeq(gomock.Any(), int64(100)).Return(boom)

			u, err := User().FindOrCreateFromGithub(ctx, GithubProfile{GithubID: "12345", Email: "a@b.com"})

			assert.ErrorIs(t, err, boom)
			assert.Nil(t, u)
			assert.Equal(t, []string{hubtest.TxBegin, hubtest.TxRollback}, txLog.Events())
		})

		// 要求 6：两个并发的同邮箱首次登录都成功，库中只有一个账号。两边都走到路径 3
		// 建号，后落库的那个撞 uk_users_email_active——这里钉住「撞这个键就回查找路径
		// 重查一次」：第二轮 FindByEmail 命中对方已提交的账号，直接绑定 identity，
		// 而不是把 1062 原样上抛给 auth_ctr 变成一次 500。
		convey.Convey("email 唯一键冲突（并发同邮箱首次登录）→ 重查一次后绑定到已存在账号", func() {
			ctx, mU, mI, mock := setupUserTest(t)
			mI.EXPECT().FindByProviderUID(gomock.Any(), "github", "12345").Return(nil, nil).Times(2)
			mU.EXPECT().FindByEmail(gomock.Any(), "a@b.com").Return(nil, nil)
			mock.ExpectBegin()
			mU.EXPECT().Create(gomock.Any(), gomock.Any()).
				Return(dupKeyErr("users", "uk_users_email_active"))
			mock.ExpectRollback()
			mU.EXPECT().FindByEmail(gomock.Any(), "a@b.com").
				Return(&user_entity.User{ID: 9, Status: consts.ACTIVE, Email: "a@b.com"}, nil)
			mI.EXPECT().Create(gomock.Any(), gomock.Any()).Return(nil)

			u, err := User().FindOrCreateFromGithub(ctx, GithubProfile{GithubID: "12345", Email: "a@b.com"})

			assert.NoError(t, err)
			assert.Equal(t, int64(9), u.ID)
			assert.NoError(t, mock.ExpectationsWereMet())
		})

		// identity 变体：两边都走到路径 3，对方先提交，本地撞
		// uk_user_identities_provider_uid。重查回到路径 1：这次 FindByProviderUID
		// 命中对方刚建好的 identity，直接按它登录。
		convey.Convey("identity 唯一键冲突（并发同 GitHub identity 首次登录）→ 重查一次后命中对方的 identity", func() {
			ctx, mU, mI, mock := setupUserTest(t)
			mS := registerSyncStateMock(t)
			gomock.InOrder(
				mI.EXPECT().FindByProviderUID(gomock.Any(), "github", "12345").Return(nil, nil),
				mI.EXPECT().FindByProviderUID(gomock.Any(), "github", "12345").
					Return(&user_identity_entity.UserIdentity{UserID: 55}, nil),
			)
			mU.EXPECT().FindByEmail(gomock.Any(), "a@b.com").Return(nil, nil)
			mock.ExpectBegin()
			mU.EXPECT().Create(gomock.Any(), gomock.Any()).
				DoAndReturn(func(_ context.Context, u *user_entity.User) error { u.ID = 100; return nil })
			mS.EXPECT().EnsureSeq(gomock.Any(), int64(100)).Return(nil)
			mI.EXPECT().Create(gomock.Any(), gomock.Any()).
				Return(dupKeyErr("user_identities", "uk_user_identities_provider_uid"))
			mock.ExpectRollback()
			mU.EXPECT().FindIgnoreStatus(gomock.Any(), int64(55)).
				Return(&user_entity.User{ID: 55, Status: consts.ACTIVE, Email: "a@b.com"}, nil)

			u, err := User().FindOrCreateFromGithub(ctx, GithubProfile{GithubID: "12345", Email: "a@b.com"})

			assert.NoError(t, err)
			assert.Equal(t, int64(55), u.ID)
			assert.NoError(t, mock.ExpectationsWereMet())
		})

		// 边界：非这两个唯一键上的错误照常上抛，不重查。
		convey.Convey("建号失败但不是这两个唯一键 → 不重查，原样报错", func() {
			ctx, mU, mI, mock := setupUserTest(t)
			mI.EXPECT().FindByProviderUID(gomock.Any(), "github", "12345").Return(nil, nil)
			mU.EXPECT().FindByEmail(gomock.Any(), "a@b.com").Return(nil, nil)
			mock.ExpectBegin()
			boom := errors.New("connection refused")
			mU.EXPECT().Create(gomock.Any(), gomock.Any()).Return(boom)
			mock.ExpectRollback()

			u, err := User().FindOrCreateFromGithub(ctx, GithubProfile{GithubID: "12345", Email: "a@b.com"})

			assert.ErrorIs(t, err, boom)
			assert.Nil(t, u)
			assert.NoError(t, mock.ExpectationsWereMet())
		})

		// 边界：重查一次后仍然撞键 → 不再重查，报错。
		convey.Convey("重查一次后仍然撞键 → 不再重查，报错", func() {
			ctx, mU, mI, mock := setupUserTest(t)
			mI.EXPECT().FindByProviderUID(gomock.Any(), "github", "12345").Return(nil, nil).Times(2)
			mU.EXPECT().FindByEmail(gomock.Any(), "a@b.com").Return(nil, nil).Times(2)
			mock.ExpectBegin()
			mU.EXPECT().Create(gomock.Any(), gomock.Any()).
				Return(dupKeyErr("users", "uk_users_email_active")).Times(2)
			mock.ExpectRollback()
			mock.ExpectBegin()
			mock.ExpectRollback()

			u, err := User().FindOrCreateFromGithub(ctx, GithubProfile{GithubID: "12345", Email: "a@b.com"})

			assert.Error(t, err)
			assert.True(t, dberr.IsDuplicateKey(err, "uk_users_email_active"))
			assert.Nil(t, u)
			assert.NoError(t, mock.ExpectationsWereMet())
		})
	})
}

// GithubLogin 回答「这个账号绑的是哪个 GitHub 账号」：它在服务层，控制器不越过
// service 直接调 user_identity_repo（依赖方向是 controller → service → repository）。
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
