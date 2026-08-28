// Package activity_repo 是账号活跃统计的数据访问层。
//
// 它只碰 agent_activity_daily 一张表，而那张表里只有**计数**：一行是「某账号、某天、
// 某台机器、某个维度组合下有几条对话」。标题、路径、对话内容在这里连列都没有——那正是
// 活跃上报开关向用户承诺的边界（migrations/202608280010_agent_activity.go）。
// 往这个包里加方法之前先问：它是不是又把内容带回来了。
package activity_repo

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/cago-frame/cago/database/db"
	"gorm.io/gorm"

	"github.com/agentre-hub/agentre-server/internal/model/entity/activity_entity"
)

//go:generate mockgen -source daily.go -destination mock_activity_repo/mock_daily.go

type DailyRepo interface {
	// ReplaceBucketsFrom 用一台机器这一次的答复，**替换**它在 [sinceDay, ∞) 这一段上
	// 的全部日计数。sinceDay 为空串时替换这台机器的全部历史（那就是回填）。
	//
	// 替换而不是合并（先删再插，不是 upsert）：机器交上来的是它对这一整段的完整答案。
	// 合并只在维度组合一模一样时才对 —— 一条会话在两轮之间换了模型，新组合是一行新桶，
	// 旧组合那一行却还留着，那一天的总数于是凭空多了一条对话；会话在机器上被删掉时同理。
	// 而计数没有对照物，多了没有任何地方会报错，界面上只是显示了一个更大的数。
	//
	// 删除只限这台机器、只限下界之后：别的机器各有各的行；下界之前的日子已经是终值
	// （按建立日分桶，过去的日子不会再变），删掉重建等于每轮重传全部历史。
	//
	// 账号与机器取参数里的这两个，载荷里带的同名字段一律不作数（对端说不了自己是谁）。
	// buckets 为空时**删除照发**：空答复的意思是「这一段我什么都没有」，而不是
	// 「这一段别动」。
	ReplaceBucketsFrom(
		ctx context.Context, userID int64, peerFingerprint, sinceDay string,
		buckets []*activity_entity.DailyBucket,
	) error
	// DeleteByUser 删掉这个账号的全部计数，返回删掉的行数。
	//
	// 关闭活跃统计开关时走这条：关闭确认弹层里明写了「已有数据一并删除」，那句承诺
	// 的兑现处就是这里。一行都没有时返回 (0, nil)——从没开过的账号关一次也是成功。
	DeleteByUser(ctx context.Context, userID int64) (int64, error)
	// LatestDay 交出这台机器已经收到哪一天了，用来算增量拉取的 since_day。
	// 一行都没有时返回空串——那是「从头拉」，不是错误。
	LatestDay(ctx context.Context, userID int64, peerFingerprint string) (string, error)
	// SumTotal 是区间内的总计数——总览页顶上那个数。
	SumTotal(ctx context.Context, q DailyQuery) (int64, error)
	// SumByDims 按给定的维度分组求和，热力图与三张分布卡都走它。
	//
	// 做成「一个方法 + 维度列表」而不是每维一个方法，理由有三条：
	//
	//  1. 模型分布本来就是**两维一组** (provider_key, model_key)，所以返回形状不可能
	//     是 map[string]int64；既然要一个带维度字段的行结构，它对五种分组都一样合用。
	//  2. 五种分组的 WHERE 完全相同，而它们必须**保持**相同：各卡片的数字加起来要等于
	//     SumTotal。分成五个方法就有五处判据要一起改，「这张卡片的数跟总计对不上」正是
	//     这么来的（对照 summary.go 的 scoped）。
	//  3. 总览页上再加一张卡片时，这里只多一个枚举常量——不动接口、不动 mock、
	//     不动 main.go 的注册。
	//
	// 维度是白名单枚举而不是列名字符串：拼进 SQL 的文本永远只来自这个包。
	// 认不出的维度、以及一个维度都不给，都是错误而不是退化成一句总计——
	// 一张标着「按后端分布」的卡片拿到一个全区间总数，是画得出来的。
	//
	// 不排序也不截断：整组结果都交回去，「取前 5 再算其它」需要完整集合才算得对，
	// 那是服务层的事。
	SumByDims(ctx context.Context, q DailyQuery, dims ...Dim) ([]DimSum, error)
}

// DailyQuery 是一次聚合读的全部判据。它只谈这张表自己的列：agent_sync_id 在这里
// 只是一个不透明的值，「这个标识还指着一个活着的 Agent 吗」要账号的名单才答得出，
// 那是服务层的事。
type DailyQuery struct {
	UserID int64
	// FromDay / ToDay 是 "2006-01-02"，**两端都含**：界面上选「8 月 1 日到 28 日」
	// 时用户数的是 28 天，写成开区间会悄悄少掉最后一天——而那一天通常是今天。
	// 空串表示那一端不设界（「全部时间」）；空串不能落进 WHERE，day>='' 会得到零行。
	FromDay string
	ToDay   string
}

// Dim 是一个分组维度。零值不是任何维度：它逼着调用方显式说出要按什么分组，
// 一个漏填的字段不会静默变成「按天」。
type Dim uint8

const (
	DimDay Dim = iota + 1
	DimAgent
	DimBackendType
	DimProvider
	DimModel
	DimProject
)

// dimColumns 把维度映射到 (投影, 分组列)。这张表是白名单本身——调用方递不进列名。
//
// day 不需要任何格式化：它在库里就是 char(10) 的 "2006-01-02"（理由见建表迁移），
// 读出来是什么就是什么。
var dimColumns = map[Dim]struct{ project, group string }{
	DimDay:         {"day", "day"},
	DimAgent:       {"agent_sync_id", "agent_sync_id"},
	DimBackendType: {"backend_type", "backend_type"},
	DimProvider:    {"provider_key", "provider_key"},
	DimModel:       {"model_key", "model_key"},
	DimProject:     {"project_sync_id", "project_sync_id"},
}

// DimSum 是一个分组及其计数。没参与分组的维度字段留空。
//
// 交回切片而不是 map[string]int64，除了模型分布是两维之外还有一条：五个维度上的
// 空串都是**有含义的值**而不是缺失（见 activity_entity 的注释），map 那种形状读起来
// 像「键就是名字」，很容易顺手写出一句 `if k == "" { continue }` 把这一组丢掉，
// 于是各卡片加起来比总计少，且少得没有规律。
type DimSum struct {
	Day           string `gorm:"column:day"`
	AgentSyncID   string `gorm:"column:agent_sync_id"`
	BackendType   string `gorm:"column:backend_type"`
	ProviderKey   string `gorm:"column:provider_key"`
	ModelKey      string `gorm:"column:model_key"`
	ProjectSyncID string `gorm:"column:project_sync_id"`
	Total         int64  `gorm:"column:total"`
}

var defaultDaily DailyRepo

func Daily() DailyRepo          { return defaultDaily }
func RegisterDaily(i DailyRepo) { defaultDaily = i }
func NewDaily() DailyRepo       { return &dailyRepo{} }

type dailyRepo struct{}

// ReplaceBucketsFrom 在一个事务里先删这一段、再写这一段。
//
// 两步必须同生共死：只删成功而没写进去，这台机器这一段的计数就凭空消失了，而下一轮
// 拉取的 since_day 取自 LatestDay —— 它会退回更早的一天，于是那一段确实还会被补回来，
// 但在那之前界面上少的是真数据。事务省掉了这个窗口。
//
// 插入不带 ON DUPLICATE KEY UPDATE：这一段刚被删空，冲突无从谈起。
//
// dims_hash 不在列名单里：它是数据库自己算的 STORED 生成列，写进去 MySQL 会拒绝整条
// 语句。挡住它的是实体上的 `gorm:"->"`（只读）。让数据库算而不是应用算，去掉的是
// 「应用与数据库对什么算同一行产生分歧、于是插入静默变成两行」这一整类 bug。
func (r *dailyRepo) ReplaceBucketsFrom(
	ctx context.Context, userID int64, peerFingerprint, sinceDay string,
	buckets []*activity_entity.DailyBucket,
) error {
	return db.Ctx(ctx).Transaction(func(tx *gorm.DB) error {
		scoped := tx.Where("user_id=? AND peer_fingerprint=?", userID, peerFingerprint)
		if sinceDay != "" {
			scoped = scoped.Where("day>=?", sinceDay)
		}
		if err := scoped.Delete(&activity_entity.DailyBucket{}).Error; err != nil {
			return err
		}
		if len(buckets) == 0 {
			// GORM 对空切片 Create 返回 ErrEmptySlice。这条路径每台机器每轮都要走，
			// 「这一段没有活动」不能变成一次上报失败——上面那次删除才是它的答复。
			return nil
		}
		// 复制而不是就地改写：载荷还要被上报路径拿去记日志或重试，改掉调用方手里的
		// 结构体会让那些地方看到一份跟自己发出去的不一样的东西。
		rows := make([]*activity_entity.DailyBucket, 0, len(buckets))
		for _, b := range buckets {
			row := *b
			// 账号与机器由调用方钉死。它们是主键的组成部分，采信对端报上来的值等于让
			// 一台机器写得进别人的统计、或把两台机器的计数并进同一批行。
			row.UserID = userID
			row.PeerFingerprint = peerFingerprint
			rows = append(rows, &row)
		}
		return tx.Create(rows).Error
	})
}

// DeleteByUser 只按 user_id 删。这张表没有软删除、没有别处的副本，WHERE 少一半就是
// 一次全表清空，而且没有任何途径能把别人的统计找回来。
//
// 行数原样交回：「关一个从没开过的账号」（0 行）与「真的删掉了 300 行」在业务上是
// 两回事，但两者都不是错误，该由服务层去分辨。
func (r *dailyRepo) DeleteByUser(ctx context.Context, userID int64) (int64, error) {
	res := db.Ctx(ctx).Where("user_id=?", userID).Delete(&activity_entity.DailyBucket{})
	if res.Error != nil {
		return 0, res.Error
	}
	return res.RowsAffected, nil
}

// LatestDay 原样读出存着的那一天，SQL 里没有任何日期格式化。
//
// 它曾经有过：早先 day 是 date 列，而本仓所有 DSN 都带 parseTime=True，驱动把它解成
// time.Time、GORM 再塞进 string 字段时用 RFC3339Nano，于是一条朴素的 `SELECT day`
// 拿回 "2026-08-28T00:00:00+08:00"——而这个值会原样变成下一次增量拉取的 since_day 发给
// 机器。列改成 char(10) 之后没有时区语义可供重新解释，格式化也就无处可加。
//
// 排序压在 day 列上，走 idx_agent_activity_daily_machine
// (user_id, peer_fingerprint, day) 的反向扫描取一行；投影列因此另起别名，免得
// ORDER BY 认到别名上去、把索引丢了。
//
// 一行都没有时 Scan 不报错、结构体保持零值，正好就是「从头拉」要的空串。
func (r *dailyRepo) LatestDay(
	ctx context.Context, userID int64, peerFingerprint string,
) (string, error) {
	var row struct {
		LatestDay string `gorm:"column:latest_day"`
	}
	if err := db.Ctx(ctx).Model(&activity_entity.DailyBucket{}).
		Select("day AS latest_day").
		Where("user_id=? AND peer_fingerprint=?", userID, peerFingerprint).
		Order("day DESC").Limit(1).Scan(&row).Error; err != nil {
		return "", err
	}
	return row.LatestDay, nil
}

// scoped 把 DailyQuery 翻成 WHERE。聚合读全部共用它——判据只有一处，各卡片与总计
// 因此不可能对不上（「这张卡片的数跟总计差了 3」正是判据分成几份写出来的）。
func (r *dailyRepo) scoped(ctx context.Context, q DailyQuery) *gorm.DB {
	tx := db.Ctx(ctx).Model(&activity_entity.DailyBucket{}).Where("user_id=?", q.UserID)
	if q.FromDay != "" {
		tx = tx.Where("day>=?", q.FromDay)
	}
	if q.ToDay != "" {
		tx = tx.Where("day<=?", q.ToDay)
	}
	return tx
}

// SumTotal 的 COALESCE 不是装饰：SUM 在空集上返回 NULL，而 database/sql 把 NULL 扫进
// int64 会直接报错（"converting NULL to int64 is unsupported"）。没有它，总览页对一个
// 区间内没有活动的账号不是显示 0，而是整页 500——新号、刚开开关的号、翻到很早那一页
// 的号都走这条路，它是常态输入而不是边角。
//
// 分组求和那边不需要这一层：每个分组至少有一行，而 session_count 是 NOT NULL。
func (r *dailyRepo) SumTotal(ctx context.Context, q DailyQuery) (int64, error) {
	var total int64
	if err := r.scoped(ctx, q).Select("COALESCE(SUM(session_count), 0)").
		Scan(&total).Error; err != nil {
		return 0, err
	}
	return total, nil
}

func (r *dailyRepo) SumByDims(ctx context.Context, q DailyQuery, dims ...Dim) ([]DimSum, error) {
	if len(dims) == 0 {
		return nil, errors.New("activity_repo: SumByDims 至少需要一个分组维度")
	}
	projects := make([]string, 0, len(dims)+1)
	tx := r.scoped(ctx, q)
	for _, d := range dims {
		col, ok := dimColumns[d]
		if !ok {
			// 认不出就当场停下，一条语句都不发：跳过它会让这次调用退化成一句
			// 无分组的总计，而调用它的卡片会把那个数画成一个分布。
			return nil, fmt.Errorf("activity_repo: 未知的分组维度 %d", d)
		}
		projects = append(projects, col.project)
		tx = tx.Group(col.group)
	}
	projects = append(projects, "SUM(session_count) AS total")

	var out []DimSum
	if err := tx.Select(strings.Join(projects, ", ")).Scan(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}
