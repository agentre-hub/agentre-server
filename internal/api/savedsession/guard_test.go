package savedsession_test

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
)

// 隐私边界守卫（本规格决策 2）：**镜像的范围就是隐私开关**——账号里保存过的对话
// 才有内容落在 server 上，没保存过的一个字都不落库。
//
// 这个守卫取代了旧的那条硬不变量（「server 不持有任何会话内容」，由本文件早先的
// 载荷字段白名单锁着）。决策 1 推翻了它：保存过的对话，其标题与整条转录**就是**
// 存在 server 上的。剩下的那条线因此变了形状，也变得更要紧——它不再是「内容一律
// 不许存」，而是「内容只许存保存过的那些」，而这条线只有守住了，「范围本身就是
// 隐私开关」这句话才成立。
//
// 三段各守一处，合起来把那句话钉死：
//  1. 会话内容只能落在 agent_session_entity 的表里（源码扫描全部实体包，新加的包自动纳入）；
//  2. 每一张持有内容的镜像表都以「账号 + 发起端指纹 + 会话标识」为身份键——正是
//     保存名单那一条的身份，因此每一行内容都属于某条保存过的对话，删除时按同一把
//     键清得掉，没保存过的对话在这些表里无处落脚；
//  3. 往镜像内容里写的代码只有 mirror_svc 一处，范围判定因此只有一个地方要守；
//     保存 / 删除这一侧只经窄接口表达「开始镜像」「清掉镜像」，自己不写内容。
func TestUnsavedConversation_LeavesNoContentInDatabase_Guard(t *testing.T) {
	root := repoRoot(t)

	t.Run("会话内容只住在 agent_session_entity 的表里", func(t *testing.T) {
		columns := scanEntityColumns(t, filepath.Join(root, "internal", "model", "entity"))
		if len(columns) == 0 {
			t.Fatal("一列都没扫到：扫描器坏了，而不是实体表干净了")
		}
		for _, bad := range contentColumnsOutsideMirror(columns) {
			t.Errorf("%s 是一个会话内容列，却落在 agent_session_entity 之外——"+
				"那张表不受「保存过才存」这个范围约束，没保存过的对话会从这里漏进库里。"+
				"内容一律进 agent_session_entity；确实与对话无关的，写进本文件的例外表并说明理由。", bad)
		}
	})

	t.Run("镜像内容以「保存过的那条对话」为身份键", func(t *testing.T) {
		// 保存名单那一条的身份：账号 + 这条对话的 conversation_id
		// （2026-08-31-conversation-centric-addressing.md「会话身份」：身份键收缩为
		// 一列，peer_fingerprint / peer_session_id 退出身份、降级为来源标注）。
		// device_fingerprint 不是身份的一半，是「去连哪一台」这个属性，但它必须在：
		// 没有它就补删不了执行端那一份。
		requireFields(t, agent_session_entity.SessionSave{}, "SessionSave",
			"UserID", "ConversationID", "DeviceFingerprint")
		// 持有内容的镜像行必须带同一把键，少一个都会让某一行内容脱离「谁保存的、
		// 保存的是哪条」——删除时清不掉，保存范围也圈不住它。
		requireFields(t, agent_session_entity.SessionSummary{}, "SessionSummary",
			"UserID", "ConversationID")
		requireFields(t, agent_session_entity.JournalFrame{}, "JournalFrame",
			"UserID", "ConversationID")
	})

	t.Run("写镜像内容的只有 mirror_svc", func(t *testing.T) {
		calls := scanContentWriterCallers(t, root)
		// 扫到零处不是「干净」，是扫描器瞎了：这一段按**方法名字符串**认写入方，
		// 改建时顺手把 UpsertSummary / WriteFrames 改个名，守卫就会一处都扫不到、
		// 无声通过，而内容写入方从此不受任何约束。仓储自己那两处实现恒在，所以
		// 「一处都没有」只可能是扫描器与被扫对象对不上了。
		if len(calls) == 0 {
			t.Fatalf("一处写入方都没扫到：contentWriterMethods %v 里的方法名多半被改过，"+
				"守卫已经在空扫。同步改这里的名字，别让它绿着", contentWriterMethods)
		}
		for _, c := range disallowedContentWriters(calls) {
			t.Errorf("%s 调用了 %s：写镜像内容的地方多了一处。"+
				"范围（哪条对话可以被存下来）只有 mirror_svc 一个地方判定；"+
				"保存 / 删除这一侧只说「开始镜像」「清掉镜像」，自己不落内容。", c.pos, c.method)
		}
	})
}

// ── 内容列扫描 ──────────────────────────────────────────────────────────────

// contentWords 是「这一列装的是对话本身」的判据。session_id / peer_fingerprint
// 这类**指向**不在其中：指向不是内容，保存名单从来就存着它们。
var contentWords = []string{
	"title", "message", "transcript", "prompt", "cwd",
	"params", "content", "payload", "text", "body",
}

// contentColumnExceptions 是明确与对话无关、因此允许留在 agent_session_entity 之外的列。
// 每一条都得说清楚它装的是什么——例外是显式的，不是悄悄敞开的口子。
var contentColumnExceptions = map[string]string{
	// 账号头像的字节与它的哈希 / MIME，与任何对话无关。
	"sync_entity.SyncAvatar.Content":     "账号头像正文",
	"sync_entity.SyncAvatar.ContentHash": "账号头像正文的哈希（主键）",
	"sync_entity.SyncAvatar.ContentType": "账号头像的 MIME",
	// 工作区同步对象（agent / 项目 / backend）的正文，不含对话。
	"sync_entity.SyncObject.Payload": "工作区同步对象正文",
}

type entityColumn struct {
	pkg    string
	strct  string
	field  string
	source string
}

func (c entityColumn) key() string { return c.pkg + "." + c.strct + "." + c.field }

// contentColumnsOutsideMirror 是守卫的判定本体，单独拎出来是为了能用一棵假的源码
// 树验证它确实会红（见 TestContentColumnGuard_HasTeeth）。
func contentColumnsOutsideMirror(columns []entityColumn) []string {
	var bad []string
	for _, c := range columns {
		if c.pkg == "agent_session_entity" {
			continue
		}
		if _, ok := contentColumnExceptions[c.key()]; ok {
			continue
		}
		lower := strings.ToLower(c.field)
		for _, w := range contentWords {
			if strings.Contains(lower, w) {
				bad = append(bad, c.source+" 的 "+c.key())
				break
			}
		}
	}
	sort.Strings(bad)
	return bad
}

// scanEntityColumns 扫出实体目录下每一个带 gorm 列标签的字段（即真正会落库的列）。
// 走源码而不是反射，是为了让新加的实体包自动进入守卫范围——反射得先 import，
// 而漏 import 的那个包恰恰是最可能出事的那个。
func scanEntityColumns(t *testing.T, dir string) []entityColumn {
	t.Helper()
	var out []entityColumn
	fset := token.NewFileSet()
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, perr := parser.ParseFile(fset, path, nil, 0)
		if perr != nil {
			// 解析不了的文件也编译不过，它不会成为任何一张表——真正的信号是那边的
			// 构建红，不是这里的守卫红。跳过它，别把别人半截的编辑记到本守卫头上。
			return nil
		}
		ast.Inspect(file, func(n ast.Node) bool {
			ts, ok := n.(*ast.TypeSpec)
			if !ok {
				return true
			}
			st, ok := ts.Type.(*ast.StructType)
			if !ok {
				return true
			}
			for _, f := range st.Fields.List {
				if f.Tag == nil || !strings.Contains(f.Tag.Value, "gorm:\"column:") {
					continue
				}
				for _, name := range f.Names {
					out = append(out, entityColumn{
						pkg: file.Name.Name, strct: ts.Name.Name, field: name.Name,
						source: filepath.Base(path),
					})
				}
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatalf("扫描实体目录 %s：%v", dir, err)
	}
	return out
}

// ── 镜像写入方扫描 ──────────────────────────────────────────────────────────

// contentWriterMethods 是把会话内容真正写进库的两个仓储方法。
var contentWriterMethods = map[string]bool{"UpsertSummary": true, "WriteFrames": true}

// allowedContentWriterDirs 是允许调用它们的包目录（相对仓库根）：仓储自己，
// 以及唯一按保存范围决定镜像谁的那个 service。
var allowedContentWriterDirs = map[string]bool{
	"internal/repository/agent_session_repo": true,
	"internal/service/mirror_svc":            true,
}

// disallowedContentWriters 是这一段守卫的判定本体，同样单独拎出来以便两向验证。
func disallowedContentWriters(calls []contentWriterCall) []contentWriterCall {
	var bad []contentWriterCall
	for _, c := range calls {
		if !allowedContentWriterDirs[c.dir] {
			bad = append(bad, c)
		}
	}
	return bad
}

type contentWriterCall struct {
	dir    string
	method string
	pos    string
}

func scanContentWriterCallers(t *testing.T, root string) []contentWriterCall {
	t.Helper()
	var out []contentWriterCall
	fset := token.NewFileSet()
	scanRoot := filepath.Join(root, "internal")
	err := filepath.WalkDir(scanRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, perr := parser.ParseFile(fset, path, nil, 0)
		if perr != nil {
			return nil // 同上：解析不了 = 编译不过，不是本守卫要报的事
		}
		rel, rerr := filepath.Rel(root, filepath.Dir(path))
		if rerr != nil {
			return rerr
		}
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || !contentWriterMethods[sel.Sel.Name] {
				return true
			}
			out = append(out, contentWriterCall{
				dir:    filepath.ToSlash(rel),
				method: sel.Sel.Name,
				pos: fmt.Sprintf("%s:%d", filepath.ToSlash(filepath.Join(rel, filepath.Base(path))),
					fset.Position(call.Pos()).Line),
			})
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatalf("扫描 %s：%v", scanRoot, err)
	}
	return out
}

// ── 守卫自身的两向验证 ──────────────────────────────────────────────────────

// 只报违规的守卫和只放行的守卫一样没用：这里用一棵假的实体树同时验证两向——
// 违规的列被点名，合规的列（指向、时间戳，以及登记过的例外）不被点名。
func TestContentColumnGuard_HasTeeth(t *testing.T) {
	dir := t.TempDir()
	writeFakeEntity(t, dir, "leaky_entity", `package leaky_entity

type Row struct {
	UserID    int64  `+"`gorm:\"column:user_id\"`"+`
	SessionID string `+"`gorm:\"column:session_id\"`"+`
	Title     string `+"`gorm:\"column:title\"`"+`
	Createtime int64 `+"`gorm:\"column:createtime\"`"+`
}
`)
	writeFakeEntity(t, dir, "agent_session_entity", `package agent_session_entity

type Summary struct {
	Title string `+"`gorm:\"column:title\"`"+`
}
`)

	bad := contentColumnsOutsideMirror(scanEntityColumns(t, dir))
	if len(bad) != 1 || !strings.Contains(bad[0], "leaky_entity.Row.Title") {
		t.Fatalf("守卫没有咬住越界的内容列，报出来的是 %v", bad)
	}
	for _, b := range bad {
		if strings.Contains(b, "UserID") || strings.Contains(b, "SessionID") ||
			strings.Contains(b, "Createtime") || strings.Contains(b, "agent_session_entity") {
			t.Errorf("守卫把指向 / 时间戳 / 镜像自己的内容列当成了违规：%s", b)
		}
	}
}

// 同样两向：允许的目录里写内容不被点名，别处写内容一定被点名。
func TestContentWriterGuard_HasTeeth(t *testing.T) {
	root := t.TempDir()
	writeFakeSource(t, filepath.Join(root, "internal", "service", "mirror_svc"), "mirror.go",
		`package mirror_svc

func replay(store frameStore) error { return store.WriteFrames(nil, nil) }
`)
	writeFakeSource(t, filepath.Join(root, "internal", "service", "other_svc"), "other.go",
		`package other_svc

func sneak(store frameStore) error { return store.WriteFrames(nil, nil) }
`)

	calls := scanContentWriterCallers(t, root)
	if len(calls) != 2 {
		t.Fatalf("扫描器没有扫到两处写入，扫到的是 %v", calls)
	}
	bad := disallowedContentWriters(calls)
	if len(bad) != 1 || bad[0].dir != "internal/service/other_svc" {
		t.Fatalf("守卫没有咬住 mirror_svc 之外的写入方，报出来的是 %v", bad)
	}
}

func writeFakeSource(t *testing.T, dir, name, src string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(src), 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeFakeEntity(t *testing.T, root, pkg, src string) {
	t.Helper()
	dir := filepath.Join(root, pkg)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, pkg+".go"), []byte(src), 0o600); err != nil {
		t.Fatal(err)
	}
}

// ── 公共小工具 ──────────────────────────────────────────────────────────────

func requireFields(t *testing.T, v any, name string, fields ...string) {
	t.Helper()
	typ := reflect.TypeOf(v)
	for _, f := range fields {
		if _, ok := typ.FieldByName(f); !ok {
			t.Errorf("%s 少了身份键字段 %s：这一行内容说不出它属于谁保存的哪条对话", name, f)
		}
	}
}

// repoRoot 从测试所在目录向上找到 go.mod（与 internal/api/http_golden_test.go 同法）。
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("找不到 go.mod：无法定位仓库根")
		}
		dir = parent
	}
}
