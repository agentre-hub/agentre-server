/**
 * drive 的纯函数与几条机械护栏(命令行解析、选择器 DSL、可驱动地址、只读 oracle、
 * 证据落盘路径、会话 Cookie)。不开浏览器:这里驱动的是「一条命令怎么变成一次动作」
 * 以及「什么动作会被当场拒绝」。
 *
 * 形状与桌面端 `agentre/e2e/lib/target.mjs` + `drive.mjs` 对齐(两个仓独立,不共享代码,
 * 但同一套流程和词汇)。守的是六处会静默走偏的地方:
 *   1. 拼错的开关被当成布尔吞掉 —— `--headles` 什么都不做,而命令仍然「成功」;
 *   2. CSS 属性选择器里的 `=` 被当成 DSL 前缀切开 → 选择器变成一段废话;
 *   3. 驱动到不该驱动的地址上(线上、别人的端口),而这在报告里看不出来;
 *   4. oracle 写数据 —— 验证只观察状态,不制造状态;
 *   5. 截图落到场景目录之外 —— 报告里的相对链接全断;
 *   6. 会话 Cookie 的 domain 与 serve 出来的 origin 不一致时不会报错,只是没带上。
 */
import { test, expect } from "@playwright/test";

import {
  assertReadOnlySQL,
  assertSanctionedURL,
  mysqlInvocation,
  parseArgs,
  parseRoleSpec,
  resolveTargetURL,
  scenarioPaths,
  sessionCookie,
  shotPath,
  splitLocator,
} from "../lib/drive-target.mjs";

const SESSION = { baseURL: "http://127.0.0.1:41234" };

test("裸命令解析成命令名与原样的位置参数", () => {
  expect(parseArgs(["goto", "/devices"])).toEqual({
    command: "goto",
    rest: ["/devices"],
    flags: {},
  });
});

test("带值的开关吃掉它的值,不把值留成位置参数", () => {
  const { command, rest, flags } = parseArgs([
    "shot",
    "v1-before",
    "--scenario",
    "2026-08-13-console",
  ]);
  expect(command).toBe("shot");
  expect(rest).toEqual(["v1-before"]);
  expect(flags.scenario).toBe("2026-08-13-console");
});

test("拼错的开关当场失败,而不是被当成布尔悄悄吞掉", () => {
  // --headles 被吞掉时命令照样返回成功,而你以为自己开了有头浏览器
  expect(() => parseArgs(["up", "--headles"])).toThrow(
    /unknown flag: --headles/,
  );
});

test("位置参数里的空格与特殊字符原样保留", () => {
  expect(parseArgs(["fill", "#user_code", "A4F 7Q2"]).rest).toEqual([
    "#user_code",
    "A4F 7Q2",
  ]);
});

test("选择器 DSL 认前缀", () => {
  expect(splitLocator("testid=nav-devices")).toEqual({
    kind: "testid",
    value: "nav-devices",
  });
  expect(splitLocator("text=批准")).toEqual({ kind: "text", value: "批准" });
});

test("CSS 属性选择器里的 = 不被当成 DSL 前缀", () => {
  // 按 indexOf("=") 切会得到 kind="button[aria-label",整条选择器就废了
  expect(splitLocator("button[aria-label^='Theme']")).toEqual({
    kind: "",
    value: "button[aria-label^='Theme']",
  });
});

test("role 选择器解析出角色与可选的无障碍名", () => {
  expect(parseRoleSpec('button[name="Save"]')).toEqual({
    role: "button",
    name: "Save",
  });
  expect(parseRoleSpec("button")).toEqual({ role: "button", name: undefined });
});

test("写坏的 role 选择器当场失败并给出正确形状", () => {
  expect(() => parseRoleSpec("button[Save]")).toThrow(
    /role=button\[name="Save"\]/,
  );
});

test("只驱动本次 target 自己的 origin", () => {
  expect(
    assertSanctionedURL(SESSION, "http://127.0.0.1:41234/devices"),
  ).toContain("/devices");
});

test("拒绝驱动外网地址", () => {
  expect(() =>
    assertSanctionedURL(SESSION, "https://console.example.com/devices"),
  ).toThrow(/refusing to drive/);
});

test("拒绝驱动同机上别的端口——那可能是你正在手调的另一套", () => {
  expect(() => assertSanctionedURL(SESSION, "http://127.0.0.1:5174/")).toThrow(
    /refusing to drive/,
  );
});

test("以 / 开头的目标按 baseURL 解析", () => {
  expect(resolveTargetURL("/devices", SESSION.baseURL)).toBe(
    "http://127.0.0.1:41234/devices",
  );
});

test("裸词当成路径,不当成协议或主机", () => {
  // new URL("devices:8443") 会解析出协议 "devices:",浏览器停在一个不存在的地址上
  expect(resolveTargetURL("devices", SESSION.baseURL)).toBe(
    "http://127.0.0.1:41234/devices",
  );
});

test("没有 baseURL 又给了相对路径时当场失败并说清缺什么", () => {
  expect(() => resolveTargetURL("/devices", "")).toThrow(/baseURL/i);
});

test("oracle 只读:SELECT / WITH / EXPLAIN 放行", () => {
  expect(() => assertReadOnlySQL("  select 1 ")).not.toThrow();
  expect(() =>
    assertReadOnlySQL("WITH x AS (select 1) select * from x"),
  ).not.toThrow();
});

test("oracle 拒绝一切写操作——验证观察状态,不制造状态", () => {
  for (const q of [
    "delete from users",
    "UPDATE devices set status='approved'",
    "insert into users values (1)",
    "truncate users",
  ]) {
    expect(() => assertReadOnlySQL(q)).toThrow(/read-only/);
  }
});

test("Go 的 MySQL DSN 拆成 mysql 客户端的参数", () => {
  const { args } = mysqlInvocation(
    "server:secret@tcp(db.invalid:3306)/server_dev?charset=utf8mb4&parseTime=True",
    "select 1",
  );
  expect(args).toEqual([
    "-h",
    "db.invalid",
    "-P",
    "3306",
    "-u",
    "server",
    "--batch",
    "--table",
    "-e",
    "select 1",
    "server_dev",
  ]);
});

test("口令走环境变量,不进命令行——否则 ps 能看到整条库口令", () => {
  const { args, env } = mysqlInvocation(
    "u:s3cr3t@tcp(127.0.0.1:3306)/db",
    "select 1",
  );
  expect(env.MYSQL_PWD).toBe("s3cr3t");
  expect(args.join(" ")).not.toContain("s3cr3t");
});

test("口令里带 @ 或 : 也能正确切开", () => {
  // 按第一个 @ 切会把口令截断,连上去的是另一套凭据(或者直接连不上)
  const { args, env } = mysqlInvocation(
    "root:p@ss:word@tcp(127.0.0.1:3306)/db",
    "select 1",
  );
  expect(env.MYSQL_PWD).toBe("p@ss:word");
  expect(args).toContain("root");
});

test("库名后面的查询参数不算库名的一部分", () => {
  const { args } = mysqlInvocation(
    "u:p@tcp(h:3306)/mydb?parseTime=True",
    "select 1",
  );
  expect(args).toContain("mydb");
  expect(args.join(" ")).not.toContain("parseTime");
});

test("不是 MySQL DSN 时当场说清,而不是把一串垃圾丢给客户端", () => {
  expect(() =>
    mysqlInvocation("postgres://u:p@127.0.0.1:5432/db", "select 1"),
  ).toThrow(/MySQL DSN/i);
});

test("场景目录把日志、截图、资源各归各位", () => {
  const dirs = scenarioPaths("/tmp/scratch", "2026-08-13-console");
  expect(dirs.root).toBe("/tmp/scratch/2026-08-13-console");
  expect(dirs.logs).toBe("/tmp/scratch/2026-08-13-console/logs");
  expect(dirs.screenshots).toBe("/tmp/scratch/2026-08-13-console/screenshots");
});

test("截图落在场景目录的 screenshots/ 下并自动补扩展名", () => {
  expect(shotPath("/tmp/scn", "v1-before")).toBe(
    "/tmp/scn/screenshots/v1-before.png",
  );
  expect(shotPath("/tmp/scn", "v1-before.png")).toBe(
    "/tmp/scn/screenshots/v1-before.png",
  );
});

test("名字里的 .. 逃逸被拒绝,证据只能留在场景目录里", () => {
  expect(() => shotPath("/tmp/scn", "../../etc/passwd")).toThrow(/scenario/i);
});

test("会话 Cookie 的 domain 取 serve 出来的那个 host,不写死 localhost", () => {
  expect(
    sessionCookie({
      serverURL: "http://127.0.0.1:41234",
      cookieName: "server_session",
      sid: "seeded-sid",
    }),
  ).toEqual({
    name: "server_session",
    value: "seeded-sid",
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
  });
});

test("serve 环境缺 sid 时当场失败,而不是开一个没登录的浏览器", () => {
  expect(() =>
    sessionCookie({
      serverURL: "http://127.0.0.1:41234",
      cookieName: "server_session",
    }),
  ).toThrow(/sid/i);
});
