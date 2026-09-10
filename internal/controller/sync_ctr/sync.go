// Package sync_ctr 是工作区多端同步端点的控制器层：取出调用方身份、转成
// service 的入参、把结果转回响应结构，不做任何判定。
package sync_ctr

import (
	"encoding/json"

	"github.com/gin-gonic/gin"

	api "github.com/agentre-hub/agentre-server/internal/api/sync"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/service/sync_svc"
)

type Sync struct{}

func New() *Sync { return &Sync{} }

// caller 取调用方账号与设备。这两个值只来自 device JWT 的 claims，不接受任何
// URL 或 body 参数——否则任何设备都能冒充别人上行。
func caller(c *gin.Context) (userID, deviceID int64) {
	return ginctx.UserID(c), ginctx.DeviceID(c)
}

func (s *Sync) Push(c *gin.Context, req *api.PushRequest) (*api.PushResponse, error) {
	userID, deviceID := caller(c)
	items := make([]sync_svc.PushItem, 0, len(req.Items))
	for _, it := range req.Items {
		items = append(items, sync_svc.PushItem{
			Kind:                it.Kind,
			SyncID:              it.SyncID,
			BaseVersion:         it.BaseVersion,
			UpdatedAt:           it.UpdatedAt,
			DeletedAt:           it.DeletedAt,
			AgentredFingerprint: it.AgentredFingerprint,
			ProjectSyncID:       it.ProjectSyncID,
			Payload:             it.Payload,
		})
	}
	out, err := sync_svc.Default().Push(c.Request.Context(),
		sync_svc.PushInput{UserID: userID, DeviceID: deviceID, Items: items})
	if err != nil {
		return nil, err
	}
	resp := &api.PushResponse{Results: make([]api.PushItemResult, 0, len(out.Results))}
	for _, r := range out.Results {
		resp.Results = append(resp.Results, api.PushItemResult{
			SyncID:                       r.SyncID,
			Kind:                         r.Kind,
			Version:                      r.Version,
			Status:                       r.Status,
			Reason:                       r.Reason,
			OverwrittenVersion:           r.OverwrittenVersion,
			OverwrittenOriginFingerprint: r.OverwrittenOriginFingerprint,
			OverwrittenPayload:           json.RawMessage(r.OverwrittenPayload),
			MergedSyncID:                 r.MergedSyncID,
			MergedVersion:                r.MergedVersion,
			MergedOriginFingerprint:      r.MergedOriginFingerprint,
		})
	}
	return resp, nil
}

func (s *Sync) Pull(c *gin.Context, req *api.PullRequest) (*api.PullResponse, error) {
	userID, deviceID := caller(c)
	out, err := sync_svc.Default().Pull(c.Request.Context(), sync_svc.PullInput{
		UserID: userID, DeviceID: deviceID, Cursor: req.Cursor, Limit: req.Limit,
	})
	if err != nil {
		return nil, err
	}
	resp := &api.PullResponse{
		Items:      make([]api.PullItem, 0, len(out.Items)),
		NextCursor: out.NextCursor,
		HasMore:    out.HasMore,
	}
	for _, it := range out.Items {
		resp.Items = append(resp.Items, api.PullItem{
			Kind:                it.Kind,
			SyncID:              it.SyncID,
			ProjectSyncID:       it.ProjectSyncID,
			AgentredFingerprint: it.AgentredFingerprint,
			Payload:             it.Payload,
			Version:             it.Version,
			UpdatedAt:           it.UpdatedAt,
			OriginFingerprint:   it.OriginFingerprint,
			DeletedAt:           it.DeletedAt,
		})
	}
	return resp, nil
}

func (s *Sync) ReportLocalPaths(c *gin.Context, req *api.ReportLocalPathsRequest) (*api.ReportLocalPathsResponse, error) {
	userID, deviceID := caller(c)
	items := make([]sync_svc.LocalPathItem, 0, len(req.Items))
	for _, it := range req.Items {
		items = append(items, sync_svc.LocalPathItem{ProjectSyncID: it.ProjectSyncID, Path: it.Path})
	}
	if err := sync_svc.Default().ReportLocalPaths(c.Request.Context(),
		sync_svc.LocalPathsInput{UserID: userID, DeviceID: deviceID, Items: items}); err != nil {
		return nil, err
	}
	return &api.ReportLocalPathsResponse{}, nil
}

func (s *Sync) PutAvatar(c *gin.Context, req *api.PutAvatarRequest) (*api.PutAvatarResponse, error) {
	userID, _ := caller(c)
	if err := sync_svc.Default().PutAvatar(c.Request.Context(), sync_svc.AvatarInput{
		UserID: userID, ContentHash: req.ContentHash, ContentType: req.ContentType, Content: req.Content,
	}); err != nil {
		return nil, err
	}
	return &api.PutAvatarResponse{ContentHash: req.ContentHash}, nil
}

func (s *Sync) GetAvatar(c *gin.Context, req *api.GetAvatarRequest) (*api.GetAvatarResponse, error) {
	userID, _ := caller(c)
	out, err := sync_svc.Default().GetAvatar(c.Request.Context(), userID, req.ContentHash)
	if err != nil {
		return nil, err
	}
	return &api.GetAvatarResponse{
		ContentHash: out.ContentHash, ContentType: out.ContentType, Content: out.Content,
	}, nil
}
