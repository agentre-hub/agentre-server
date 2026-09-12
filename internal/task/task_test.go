package task

import (
	"context"
	"errors"
	"testing"

	"github.com/cago-frame/cago/server/cron"
	robfigcron "github.com/robfig/cron/v3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// specCrontab 是 cago 那层 crontab 去掉 tracing 与日志之后剩下的东西：AddFunc 的
// 错误就是 robfig/cron 解析 spec 的结果，和生产上同一个来源。reject 让用例复现
// 「这一条注册不上」，而不必去编一个 cron 真的认不出的 spec 字面量。
type specCrontab struct {
	inner  *robfigcron.Cron
	reject error
	specs  []string
}

func newSpecCrontab(t *testing.T, reject error) *specCrontab {
	t.Helper()
	previous := cron.Default()
	c := &specCrontab{inner: robfigcron.New(), reject: reject}
	cron.SetDefault(c)
	t.Cleanup(func() { cron.SetDefault(previous) })
	return c
}

func (c *specCrontab) AddFunc(spec string, cmd func(ctx context.Context) error) (robfigcron.EntryID, error) {
	c.specs = append(c.specs, spec)
	if c.reject != nil {
		return 0, c.reject
	}
	return c.inner.AddFunc(spec, func() { _ = cmd(context.Background()) })
}

// Given cron 收不下某个任务（spec 写错了、或者组件的状态不对）；When 进程启动；
// Then Task 把这件事交上去 —— main 据此 fatal。
//
// 吞掉它的代价是没有任何可观察痕迹：清理不跑、镜像不对账、活跃统计不拉、发布版本
// 不更新，而进程照样起来、healthz 照样 200、日志里一个字都没有。errcheck 也拦不住，
// 它对显式的 `_ =` 无话可说。
func TestTask_CronRejectsARegistration_StartupFails(t *testing.T) {
	rejected := errors.New("expected exactly 5 fields, found 1: [bogus]")
	c := newSpecCrontab(t, rejected)

	err := Task(context.Background(), nil)

	require.Error(t, err, "注册失败必须让启动失败，而不是安静地少跑几个任务")
	assert.ErrorIs(t, err, rejected, "上交的错误要能追到 cron 给出的那一个")
	assert.NotEmpty(t, c.specs)
}

// Given 定时任务组件已经就绪；When 进程启动；Then 每一条 spec 都被 cron 接住，
// 启动不报错。
//
// 这一条是上面那条的另一半：只有「坏的会红」，一个把全部注册都判成失败的实现也能绿。
func TestTask_EveryScheduleRegistersWithAParsableSpec(t *testing.T) {
	c := newSpecCrontab(t, nil)

	require.NoError(t, Task(context.Background(), nil))

	assert.Len(t, c.inner.Entries(), len(c.specs),
		"每一条注册都要真的落进 cron 里")
	assert.NotEmpty(t, c.specs)
}

// Given cron 组件没被注册（装配顺序被改动过）；When 进程启动；Then 说清是哪一件事，
// 而不是在一个 nil 接口上取方法、以一条 nil pointer dereference 收场。
func TestTask_CronComponentMissing_SaysSo(t *testing.T) {
	previous := cron.Default()
	cron.SetDefault(nil)
	t.Cleanup(func() { cron.SetDefault(previous) })

	err := Task(context.Background(), nil)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "cron")
}
