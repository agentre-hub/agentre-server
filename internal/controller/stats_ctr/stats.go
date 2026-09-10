// Package stats_ctr 把浏览器会话的账号身份接到活跃统计服务，并在两处补上服务层刻意
// 不给的那一件事——**设备**：在线台数与总台数，以及逐台机器「已上报到哪一天」。
//
// 设备是设备域的事实，活跃统计服务不认识它；把两边拼在一起是控制器这一层的活。
package stats_ctr

import (
	"github.com/gin-gonic/gin"

	deviceapi "github.com/agentre-hub/agentre-server/internal/api/device"
	api "github.com/agentre-hub/agentre-server/internal/api/stats"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/service/activity_svc"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
)

// defaultRange 是不带 range 时的那一档。绑定层只认三个值，因此这里补的一定是
// 服务层认得出的键。
const defaultRange = "30d"

type Stats struct{}

func New() *Stats { return &Stats{} }

func (s *Stats) Overview(c *gin.Context, req *api.OverviewRequest) (*api.OverviewResponse, error) {
	ctx := c.Request.Context()
	rangeKey := req.Range
	if rangeKey == "" {
		rangeKey = defaultRange
	}
	view, err := activity_svc.Activity().Overview(ctx, ginctx.UserID(c), rangeKey)
	if err != nil {
		return nil, err
	}
	devices, err := s.listDevices(c)
	if err != nil {
		return nil, err
	}
	online := 0
	for _, d := range devices {
		if d.Online {
			online++
		}
	}
	return &api.OverviewResponse{
		ActivityStatsEnabled: view.ActivityStatsEnabled,
		Scope:                view.Scope,
		TimeZone:             view.TimeZone,
		Summary: api.Summary{
			Conversations:      view.Summary.Conversations,
			ConversationsTotal: view.Summary.ConversationsTotal,
			StreakDays:         view.Summary.StreakDays,
			LongestStreakDays:  view.Summary.LongestStreakDays,
			ActiveDays:         view.Summary.ActiveDays,
			WindowDays:         view.Summary.WindowDays,
			DevicesOnline:      online,
			DevicesTotal:       len(devices),
		},
		Heatmap:  heatmap(view.Heatmap),
		Agents:   agents(view.Agents),
		Backends: backends(view.Backends),
		Models:   models(view.Models),
		Projects: projects(view.Projects),
	}, nil
}

func (s *Stats) Settings(c *gin.Context, _ *api.SettingsRequest) (*api.SettingsResponse, error) {
	return s.settings(c)
}

func (s *Stats) SaveSettings(c *gin.Context, req *api.SaveSettingsRequest) (*api.SettingsResponse, error) {
	enabled := *req.ActivityStatsEnabled
	if err := activity_svc.Activity().SetActivityStats(
		c.Request.Context(), ginctx.UserID(c), enabled, req.Backfill,
	); err != nil {
		return nil, err
	}
	// 写完**重新读一次**再回：拿请求体拼一份回执，交出去的就是「我以为写成了什么」，
	// 而前端的开关正是跟着这份回执走的。
	return s.settings(c)
}

// settings 是 GET 与 PUT 共用的那一份组装：开关本身来自活跃统计服务，逐台机器那一段
// 由设备清单与上报进度拼出来。
func (s *Stats) settings(c *gin.Context) (*api.SettingsResponse, error) {
	ctx := c.Request.Context()
	userID := ginctx.UserID(c)
	view, err := activity_svc.Activity().Settings(ctx, userID)
	if err != nil {
		return nil, err
	}
	resp := &api.SettingsResponse{
		ActivityStatsEnabled: view.ActivityStatsEnabled,
		LastReportAt:         view.LastReportAt,
		SavedConversations:   view.SavedConversations,
		Today:                view.Today,
	}
	devices, err := s.listDevices(c)
	if err != nil {
		return nil, err
	}
	if len(devices) == 0 {
		// 一台设备都没有就没有「逐台进度」可言，也不必去问服务要一张空表。
		return resp, nil
	}
	fingerprints := make([]string, 0, len(devices))
	for _, d := range devices {
		fingerprints = append(fingerprints, d.Fingerprint)
	}
	through, err := activity_svc.Activity().ReportedThrough(ctx, userID, fingerprints)
	if err != nil {
		return nil, err
	}
	resp.Devices = make([]api.DeviceReport, 0, len(devices))
	for _, d := range devices {
		// 没上报过的机器不在 map 里，取到的空串被 omitempty 吃掉——字段缺席，
		// 而不是一个空的日期占位。
		resp.Devices = append(resp.Devices, api.DeviceReport{
			DeviceID:        d.ID,
			Name:            d.Name,
			Online:          d.Online,
			ReportedThrough: through[d.Fingerprint],
		})
	}
	return resp, nil
}

func (s *Stats) listDevices(c *gin.Context) ([]deviceapi.ListDevicesItem, error) {
	return device_svc.Default().ListUserDevices(
		c.Request.Context(), ginctx.UserID(c), ginctx.DeviceID(c),
	)
}

// heatmap 及下面四个映射一律 make(..., 0, len)：nil 切片在 JSON 里是 null，而前端对
// 它们是直接 map 的。
func heatmap(in activity_svc.HeatmapView) api.Heatmap {
	out := api.Heatmap{
		From:            in.From,
		To:              in.To,
		Days:            make([]api.Day, 0, len(in.Days)),
		AvgPerActiveDay: in.AvgPerActiveDay,
	}
	for _, d := range in.Days {
		out.Days = append(out.Days, api.Day{Day: d.Day, Count: d.Count})
	}
	if in.BusiestDay != nil {
		out.BusiestDay = &api.Day{Day: in.BusiestDay.Day, Count: in.BusiestDay.Count}
	}
	return out
}

func agents(in []activity_svc.AgentCount) []api.AgentRow {
	out := make([]api.AgentRow, 0, len(in))
	for _, r := range in {
		out = append(out, api.AgentRow{SyncID: r.SyncID, Count: r.Count})
	}
	return out
}

func backends(in []activity_svc.BackendCount) []api.BackendRow {
	out := make([]api.BackendRow, 0, len(in))
	for _, r := range in {
		out = append(out, api.BackendRow{BackendType: r.BackendType, Count: r.Count})
	}
	return out
}

func models(in []activity_svc.ModelCount) []api.ModelRow {
	out := make([]api.ModelRow, 0, len(in))
	for _, r := range in {
		out = append(out, api.ModelRow{ProviderKey: r.ProviderKey, ModelKey: r.ModelKey, Count: r.Count})
	}
	return out
}

func projects(in []activity_svc.ProjectCount) []api.ProjectRow {
	out := make([]api.ProjectRow, 0, len(in))
	for _, r := range in {
		out = append(out, api.ProjectRow{SyncID: r.SyncID, Count: r.Count})
	}
	return out
}
