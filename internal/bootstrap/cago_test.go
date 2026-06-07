//go:build integration

package bootstrap_test

import (
	"context"
	"testing"

	"github.com/cago-frame/cago/database/db"
	_ "github.com/cago-frame/cago/database/db/postgres"
	"github.com/stretchr/testify/require"
	pgcontainer "github.com/testcontainers/testcontainers-go/modules/postgres"
	pgdialect "gorm.io/driver/postgres"
	"gorm.io/gorm"

	"agentre-server/migrations"
)

func TestMigrations_RealPG(t *testing.T) {
	ctx := context.Background()
	pgC, err := pgcontainer.Run(ctx,
		"postgres:16-alpine",
		pgcontainer.WithUsername("server"),
		pgcontainer.WithPassword("server"),
		pgcontainer.WithDatabase("server"),
	)
	require.NoError(t, err)
	t.Cleanup(func() { _ = pgC.Terminate(ctx) })

	dsn, err := pgC.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)

	gormDB, err := gorm.Open(pgdialect.Open(dsn), &gorm.Config{})
	require.NoError(t, err)
	db.SetDefault(gormDB)

	require.NoError(t, migrations.RunMigrations(gormDB))

	// 校验 5 张表存在
	for _, tbl := range []string{"users", "user_identities", "devices", "device_tokens", "device_flow_codes"} {
		var n int64
		require.NoError(t, gormDB.Raw(
			"SELECT count(*) FROM information_schema.tables WHERE table_name = ?", tbl,
		).Scan(&n).Error)
		require.Equal(t, int64(1), n, "table %s missing", tbl)
	}
}
