/**
 * run-e2e-web.mjs 的运行模式选择与 serve 交接件。不起服务器:这里驱动的是
 * 「这次运行到底要不要跑 spec」以及「撑住不退时把什么交给 drive」两个纯函数。
 *
 * 守的是两处:
 *   1. 未知开关会原样漏给 playwright —— 原来的写法只滤掉 --dual,新增的 --serve
 *      会被当成 playwright 的参数,运行时死在 "unknown option",看起来像 runner 坏了;
 *   2. serve 交接件少一样东西(尤其 sid)时不会报错,drive 会开出一个没登录的
 *      浏览器,然后一路验的都是登录页。
 */
import { test, expect } from "@playwright/test";

import { parseRunnerArgs, serveEnvPayload } from "../run-e2e-web.mjs";

test("默认跑 spec,不进 serve 档", () => {
  expect(parseRunnerArgs([])).toEqual({
    mode: "spec",
    dual: false,
    playwrightArgs: [],
  });
});

test("--dual 仍然只切换双端,并且不漏给 playwright", () => {
  expect(parseRunnerArgs(["--dual"])).toEqual({
    mode: "spec",
    dual: true,
    playwrightArgs: [],
  });
});

test("--serve 切到撑住不退档,并且不漏给 playwright", () => {
  // 漏过去的话 playwright 会死在 unknown option —— 而 serve 档根本不该起 playwright
  expect(parseRunnerArgs(["--serve"])).toEqual({
    mode: "serve",
    dual: false,
    playwrightArgs: [],
  });
});

test("--serve 与 --dual 同时给时两个都认,仍不漏参数", () => {
  expect(parseRunnerArgs(["--serve", "--dual"])).toEqual({
    mode: "serve",
    dual: true,
    playwrightArgs: [],
  });
});

test("其余参数原样透传给 playwright", () => {
  expect(parseRunnerArgs(["-g", "device flow", "--headed"])).toEqual({
    mode: "spec",
    dual: false,
    playwrightArgs: ["-g", "device flow", "--headed"],
  });
});

test("serve 交接件带齐 drive 登录所需的三样,以及排错要看的日志", () => {
  const payload = serveEnvPayload({
    WEBE2E_SERVER_URL: "http://127.0.0.1:41234",
    WEBE2E_COOKIE_NAME: "server_session",
    WEBE2E_SESSION_SID: "seeded-sid",
    WEBE2E_SERVER_LOG: "/tmp/aw1/server.log",
    WEBE2E_AGENTRED_LOG: "/tmp/aw1/agentred.log",
    WEBE2E_RUN_ID: "abc123",
  });
  expect(payload).toMatchObject({
    serverURL: "http://127.0.0.1:41234",
    cookieName: "server_session",
    sid: "seeded-sid",
    serverLog: "/tmp/aw1/server.log",
    agentredLog: "/tmp/aw1/agentred.log",
    runID: "abc123",
  });
});

test("交接件带上 DSN —— 没有它 `drive sql` 这个独立 oracle 就用不了", () => {
  const payload = serveEnvPayload(
    {
      WEBE2E_SERVER_URL: "http://127.0.0.1:41234",
      WEBE2E_COOKIE_NAME: "server_session",
      WEBE2E_SESSION_SID: "seeded-sid",
    },
    { dsn: "u:p@tcp(127.0.0.1:3306)/agentre" },
  );
  expect(payload.dsn).toBe("u:p@tcp(127.0.0.1:3306)/agentre");
  // 没传就是 null,而不是 undefined —— 交接件里这一栏必须存在,drive 才能给出
  // 「这次没有 DSN,自己去查库」而不是一句 undefined
  expect(
    serveEnvPayload({
      WEBE2E_SERVER_URL: "http://127.0.0.1:41234",
      WEBE2E_COOKIE_NAME: "server_session",
      WEBE2E_SESSION_SID: "seeded-sid",
    }).dsn,
  ).toBeNull();
});

test("serve 交接件缺 sid 时当场失败,而不是交出一份开不出登录态的环境", () => {
  expect(() =>
    serveEnvPayload({
      WEBE2E_SERVER_URL: "http://127.0.0.1:41234",
      WEBE2E_COOKIE_NAME: "server_session",
    }),
  ).toThrow(/WEBE2E_SESSION_SID/);
});
