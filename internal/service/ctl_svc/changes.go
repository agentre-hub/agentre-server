package ctl_svc

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/agentre-hub/agentre/pkg/wire/agentrewire"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// 写请求的字段合并与变更清单，语义与桌面端执行者（agentre internal/service/ctl_svc 的
// merge.go / changes.go）一致：执行者只信字段集合里列出的字段；前后值对照当前数据算，
// 引用写成对方的名字，密钥只标记「已写入」。两个 Go 模块不能互相 import，所以这里是
// 同一份规则在 server 上的实现，契约（字段名、可写时机）由 pkg/wire 的 Ctl* 消息钉住。

const (
	writeOnCreate = 1 << iota
	writeOnUpdate
	writeAlways = writeOnCreate | writeOnUpdate
)

// writableFields 是每类资源可写的字段及其时机；不在表里的是只读字段。后端的 cliPath
// 只读：CLI 路径覆盖不在本 spec 内（Out of scope），继续在桌面端或控制台界面里改。
var writableFields = map[agentrewire.CtlKind]map[string]int{
	agentrewire.CtlKind_CTL_KIND_AGENT: {
		"name": writeAlways, "description": writeAlways, "departmentId": writeAlways, "backendIds": writeAlways,
		"pinned": writeAlways, "avatarColor": writeAlways, "avatarIcon": writeAlways,
	},
	agentrewire.CtlKind_CTL_KIND_DEPARTMENT: {
		"name": writeAlways, "description": writeAlways, "icon": writeAlways, "accentColor": writeAlways,
		"parentId": writeAlways, "leadAgentId": writeAlways,
	},
	agentrewire.CtlKind_CTL_KIND_PROJECT: {
		"name": writeAlways, "description": writeAlways, "icon": writeAlways, "color": writeAlways,
		"path": writeAlways, "parentId": writeAlways, "memberAgentIds": writeOnCreate,
	},
	agentrewire.CtlKind_CTL_KIND_PROVIDER: {
		"type": writeOnCreate, "name": writeAlways, "baseUrl": writeAlways, "apiKey": writeAlways,
		"enabled": writeAlways, "defaultModelKey": writeOnUpdate,
	},
	agentrewire.CtlKind_CTL_KIND_MODEL: {
		"providerId": writeOnCreate, "modelId": writeAlways, "name": writeAlways, "contextWindow": writeAlways,
		"maxOutput": writeAlways, "enabled": writeAlways, "isDefault": writeAlways,
	},
	agentrewire.CtlKind_CTL_KIND_BACKEND: {
		"type": writeOnCreate, "name": writeAlways, "device": writeAlways,
		"providerId": writeAlways, "modelId": writeAlways, "reasoningEffort": writeAlways, "env": writeAlways,
		"configJson": writeAlways, "token": writeAlways,
	},
}

// refFields 是各类资源里引用其它资源的字段。
var refFields = map[agentrewire.CtlKind]map[string]agentrewire.CtlKind{
	agentrewire.CtlKind_CTL_KIND_AGENT: {
		"departmentId": agentrewire.CtlKind_CTL_KIND_DEPARTMENT, "backendIds": agentrewire.CtlKind_CTL_KIND_BACKEND,
	},
	agentrewire.CtlKind_CTL_KIND_DEPARTMENT: {
		"parentId": agentrewire.CtlKind_CTL_KIND_DEPARTMENT, "leadAgentId": agentrewire.CtlKind_CTL_KIND_AGENT,
	},
	agentrewire.CtlKind_CTL_KIND_PROJECT: {
		"parentId": agentrewire.CtlKind_CTL_KIND_PROJECT, "memberAgentIds": agentrewire.CtlKind_CTL_KIND_AGENT,
	},
	agentrewire.CtlKind_CTL_KIND_MODEL: {"providerId": agentrewire.CtlKind_CTL_KIND_PROVIDER},
	agentrewire.CtlKind_CTL_KIND_BACKEND: {
		"providerId": agentrewire.CtlKind_CTL_KIND_PROVIDER, "modelId": agentrewire.CtlKind_CTL_KIND_MODEL,
	},
}

var secretFields = map[string]bool{"apiKey": true, "token": true}

func docMessage(r *agentrewire.CtlResource) protoreflect.Message {
	if r == nil {
		return nil
	}
	m := r.ProtoReflect()
	fd := m.WhichOneof(m.Descriptor().Oneofs().ByName("doc"))
	if fd == nil {
		return nil
	}
	return m.Get(fd).Message()
}

func docKindOf(r *agentrewire.CtlResource) agentrewire.CtlKind {
	m := docMessage(r)
	if m == nil {
		return agentrewire.CtlKind_CTL_KIND_UNSPECIFIED
	}
	name := string(r.ProtoReflect().WhichOneof(r.ProtoReflect().Descriptor().Oneofs().ByName("doc")).Name())
	for kind, n := range kindNames {
		if n == name {
			return kind
		}
	}
	return agentrewire.CtlKind_CTL_KIND_UNSPECIFIED
}

func newDocOf(kind agentrewire.CtlKind) *agentrewire.CtlResource {
	r := &agentrewire.CtlResource{}
	m := r.ProtoReflect()
	fd := m.Descriptor().Fields().ByName(protoreflect.Name(kindNames[kind]))
	m.Set(fd, m.NewField(fd))
	return r
}

func opName(op agentrewire.CtlOp) string {
	switch op {
	case agentrewire.CtlOp_CTL_OP_CREATE:
		return "create"
	case agentrewire.CtlOp_CTL_OP_UPDATE:
		return "update"
	case agentrewire.CtlOp_CTL_OP_DELETE:
		return "delete"
	}
	return op.String()
}

// mergeDoc 算出写入后的完整文档：cur（create 时为空文档）叠加 fields 列出的字段。
// configJson 只替换请求里出现的键。密钥字段只有本次写入时才保留值——cur 里是掩码。
func mergeDoc(kind agentrewire.CtlKind, op agentrewire.CtlOp, cur, req *agentrewire.CtlResource, fields []string) (*agentrewire.CtlResource, error) {
	allowed := writableFields[kind]
	when := writeOnUpdate
	if op == agentrewire.CtlOp_CTL_OP_CREATE {
		when = writeOnCreate
	}
	var next *agentrewire.CtlResource
	if cur != nil {
		next = proto.Clone(cur).(*agentrewire.CtlResource)
	} else {
		next = newDocOf(kind)
	}
	nm := docMessage(next)
	if len(fields) > 0 && docKindOf(req) != kind {
		return nil, badRequest("the request document is not a %s", kindNames[kind])
	}
	rm := docMessage(req)
	set := map[string]bool{}
	for _, f := range fields {
		fd := nm.Descriptor().Fields().ByJSONName(f)
		if fd == nil || allowed[f]&when == 0 {
			return nil, badRequest("%s field %q cannot be written by %s", kindNames[kind], f, opName(op))
		}
		set[f] = true
		if f == "configJson" {
			merged, err := mergeConfigJSON(nm.Get(fd).String(), rm.Get(fd).String())
			if err != nil {
				return nil, err
			}
			nm.Set(fd, protoreflect.ValueOfString(merged))
			continue
		}
		v := rm.Get(fd)
		if (fd.IsList() && v.List().Len() == 0) || (fd.IsMap() && v.Map().Len() == 0) {
			nm.Clear(fd)
			continue
		}
		nm.Set(fd, v)
	}
	if p := next.GetProvider(); p != nil && !set["apiKey"] {
		p.ApiKey = ""
	}
	if b := next.GetBackend(); b != nil && !set["token"] {
		b.Token = ""
	}
	return next, nil
}

func mergeConfigJSON(cur, req string) (string, error) {
	out := map[string]json.RawMessage{}
	if cur != "" {
		if err := json.Unmarshal([]byte(cur), &out); err != nil || out == nil {
			out = map[string]json.RawMessage{}
		}
	}
	var patch map[string]json.RawMessage
	if err := json.Unmarshal([]byte(req), &patch); err != nil || patch == nil {
		return "", badRequest("configJson must be a JSON object")
	}
	for k, v := range patch {
		out[k] = v
	}
	raw, err := json.Marshal(out)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// mergeMembers 是 update 时项目成员的增减：保持原顺序，去掉 remove，追加新的 add。
func mergeMembers(cur, add, remove []int64) []int64 {
	drop := map[int64]bool{}
	for _, id := range remove {
		drop[id] = true
	}
	var out []int64
	seen := map[int64]bool{}
	for _, id := range append(append([]int64(nil), cur...), add...) {
		if drop[id] || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

// ---- 变更清单 ----

// refName 是被引用资源的名字：模型用 ModelID，其它用名字；找不到写 #id。
func (st *state) refName(kind agentrewire.CtlKind, id int64) string {
	it, err := st.get(kind, id)
	if err != nil {
		return "#" + strconv.FormatInt(id, 10)
	}
	if m := it.GetModel(); m != nil {
		return m.GetModelId()
	}
	m := docMessage(it)
	return m.Get(m.Descriptor().Fields().ByName("name")).String()
}

// label 是资源在变更清单里的名字；模型写成 提供方/ModelID（决策 9）。
func (st *state) label(r *agentrewire.CtlResource) string {
	if m := r.GetModel(); m != nil {
		return st.refName(agentrewire.CtlKind_CTL_KIND_PROVIDER, m.GetProviderId()) + "/" + m.GetModelId()
	}
	m := docMessage(r)
	return m.Get(m.Descriptor().Fields().ByName("name")).String()
}

func (st *state) format(kind agentrewire.CtlKind, m protoreflect.Message, fd protoreflect.FieldDescriptor) *string {
	name := fd.JSONName()
	v := m.Get(fd)
	if ref, ok := refFields[kind][name]; ok {
		var ids []int64
		if fd.IsList() {
			for i := 0; i < v.List().Len(); i++ {
				ids = append(ids, v.List().Get(i).Int())
			}
		} else if v.Int() != 0 {
			ids = []int64{v.Int()}
		}
		names := make([]string, 0, len(ids))
		for _, id := range ids {
			names = append(names, st.refName(ref, id))
		}
		return nonEmpty(strings.Join(names, ", "))
	}
	if kind == agentrewire.CtlKind_CTL_KIND_PROVIDER && name == "defaultModelKey" {
		for i := range st.models {
			if st.models[i].key == v.String() {
				s := st.models[i].model.ModelID
				return &s
			}
		}
		return nonEmpty(v.String())
	}
	switch {
	case fd.IsMap():
		var pairs []string
		v.Map().Range(func(k protoreflect.MapKey, val protoreflect.Value) bool {
			pairs = append(pairs, k.String()+"="+val.String())
			return true
		})
		sort.Strings(pairs)
		return nonEmpty(strings.Join(pairs, ", "))
	case fd.Kind() == protoreflect.BoolKind:
		s := strconv.FormatBool(v.Bool())
		return &s
	case fd.Kind() == protoreflect.StringKind:
		return nonEmpty(v.String())
	case fd.Kind() == protoreflect.Int64Kind || fd.Kind() == protoreflect.Int32Kind:
		if v.Int() == 0 {
			return nil
		}
		s := strconv.FormatInt(v.Int(), 10)
		return &s
	}
	s := fmt.Sprint(v.Interface())
	return &s
}

func nonEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func sameValue(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// fieldChanges 算 create / update 的字段前后值；update 时没变的字段不列。
func (st *state) fieldChanges(kind agentrewire.CtlKind, cur, next *agentrewire.CtlResource, fields []string) ([]*agentrewire.CtlFieldChange, error) {
	nm := docMessage(next)
	var cm protoreflect.Message
	if cur != nil {
		cm = docMessage(cur)
	}
	var out []*agentrewire.CtlFieldChange
	for _, f := range fields {
		fd := nm.Descriptor().Fields().ByJSONName(f)
		switch {
		case secretFields[f]:
			// 空的 api key 按服务层规则是「沿用原值」，不算变更。
			if nm.Get(fd).String() != "" {
				out = append(out, &agentrewire.CtlFieldChange{Field: f, Secret: true})
			}
		case f == "configJson":
			before := ""
			if cm != nil {
				before = cm.Get(fd).String()
			}
			changes, err := configChanges(before, nm.Get(fd).String())
			if err != nil {
				return nil, err
			}
			out = append(out, changes...)
		default:
			var before *string
			if cm != nil {
				before = st.format(kind, cm, fd)
			}
			after := st.format(kind, nm, fd)
			if cm != nil && sameValue(before, after) {
				continue
			}
			out = append(out, &agentrewire.CtlFieldChange{Field: f, Before: before, After: after})
		}
	}
	return out, nil
}

func configChanges(before, after string) ([]*agentrewire.CtlFieldChange, error) {
	b, err := configValues(before)
	if err != nil {
		return nil, err
	}
	a, err := configValues(after)
	if err != nil {
		return nil, err
	}
	keys := map[string]bool{}
	for k := range b {
		keys[k] = true
	}
	for k := range a {
		keys[k] = true
	}
	sorted := make([]string, 0, len(keys))
	for k := range keys {
		sorted = append(sorted, k)
	}
	sort.Strings(sorted)
	var out []*agentrewire.CtlFieldChange
	for _, k := range sorted {
		if sameValue(b[k], a[k]) {
			continue
		}
		out = append(out, &agentrewire.CtlFieldChange{Field: "config." + k, Before: b[k], After: a[k]})
	}
	return out, nil
}

func configValues(raw string) (map[string]*string, error) {
	out := map[string]*string{}
	if raw == "" {
		return out, nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &obj); err != nil {
		return nil, badRequest("configJson must be a JSON object")
	}
	for k, v := range obj {
		var s string
		if json.Unmarshal(v, &s) == nil {
			out[k] = nonEmpty(s)
			continue
		}
		if t := strings.TrimSpace(string(v)); t != "null" {
			out[k] = &t
		}
	}
	return out, nil
}

func plural(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return fmt.Sprintf("%d %ss", n, noun)
}
