import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Login from "@/pages/Login";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import i18n from "@/i18n";
import {
  b64urlToBuffer as b64urlToBufferForTest,
  fakeCredentialsGet,
} from "@/test/webauthn";

function renderLogin(search: string = "") {
  // Login.tsx 直接读 window.location.search（而不是 useLocation），
  // 所以 query 要从 window 上塞进去，MemoryRouter 的 initialEntries 喂不到它。
  Object.defineProperty(window, "location", {
    value: {
      ...window.location,
      search: search,
      assign: vi.fn(),
      href: "/login" + search,
    },
    writable: true,
  });

  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Login />
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

// 通行密钥那几条用例把 fetch / navigator / PublicKeyCredential 整个换掉。不还原的
// 话它们会活到本文件后面的用例里，谁先跑谁不同——一种只在改动了用例顺序时才发作
// 的失败。vitest.config.ts 没开 unstubGlobals，所以得自己来。
afterEach(() => {
  vi.unstubAllGlobals();
  // isSecureContext 那几条用 spyOn 换掉取值器，不还原同样会活到后面的用例里。
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "PublicKeyCredential");
});

describe("Login", () => {
  describe("form structure", () => {
    it("shows the title", () => {
      renderLogin();
      expect(
        screen.getByRole("heading", { level: 1, name: /Sign in to AgentRe/i }),
      ).toBeTruthy();
    });

    it("shows the GitHub login button", () => {
      renderLogin();
      expect(
        screen.getByRole("button", { name: /Sign in with GitHub/i }),
      ).toBeTruthy();
    });

    // spec「认证外壳」的卡片表：「宽度按屏内容定：登录 424…」，
    // 以及「间距」：「卡片内间距桌面 36–40，移动 24–28」。
    // max-w-sm 是 384，而一个常量 p-9 会把 36 的桌面留白照搬到手机上。
    it("is 424 wide and pads 24 on mobile, 36 from sm: up", () => {
      renderLogin();
      const card = screen.getByRole("heading", { level: 1 }).parentElement;
      expect(card?.className).toContain("max-w-[424px]");
      expect(card?.className).toContain("p-6");
      expect(card?.className).toContain("sm:p-9");
    });

    it("shows a footer note about terms and privacy", () => {
      renderLogin();
      expect(
        screen.getByText(/By continuing, you agree to AgentRe/i),
      ).toBeTruthy();
    });
  });

  describe("user_code context strip", () => {
    it("does not show context strip when user_code is absent", () => {
      renderLogin();
      // 断言上下文条自己的内容缺席，而不是查一个 svg 的 role：裸 <svg> 在
      // aria-query 里根本没有隐式 role，那个查询无论渲不渲染都返回 null
      // ——同一页上那个永远都在的 GitHub 图标就是反证。
      expect(
        screen.queryByText(/Continue to device authorization/i),
      ).toBeNull();
      expect(document.querySelector(".bg-primary-soft")).toBeNull();
    });

    it("shows context strip when user_code is in URL", () => {
      renderLogin("?user_code=A4F-7Q2");
      expect(screen.getByText("A4F-7Q2")).toBeTruthy();
    });

    it("uses mono font for the device code in context strip", () => {
      renderLogin("?user_code=A4F-7Q2");
      // spec「登录」：「下面是等宽的设备码」——0/O、1/l 要一眼分得开
      const strip = document.querySelector(".font-mono");
      expect(strip?.textContent).toContain("A4F-7Q2");
    });

    it("context strip has primary-soft background", () => {
      renderLogin("?user_code=A4F-7Q2");
      // spec「登录」：「插入一块 primary-soft 的上下文条」
      const strip = document.querySelector(".bg-primary-soft");
      expect(strip).toBeTruthy();
    });
  });

  describe("error handling", () => {
    it("does not show error when err param is absent", () => {
      renderLogin();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    // spec「失败路径 · 登录失败」：Alert「含标题「登录未完成」与具体原因」
    it("shows a titled failure alert when err param is present", () => {
      renderLogin("?err=access_denied");
      expect(screen.getByRole("alert").textContent).toContain(
        "Sign in unsuccessful",
      );
    });

    it("shows retry button when err is present", () => {
      renderLogin("?err=access_denied");
      expect(
        screen.getByRole("button", { name: /Sign in again/i }),
      ).toBeTruthy();
    });

    it("hides GitHub login button when error is shown", () => {
      renderLogin("?err=access_denied");
      // 失败态里只留「重新登录」一个动作，两个登录按钮会让人不知道该点哪个
      expect(screen.queryByRole("button", { name: /GitHub/i })).toBeNull();
    });

    // 六条已知 err 走 locale 文案，而不是把后端的原始码抛给用户
    it("uses known error message for recognized err codes", () => {
      renderLogin("?err=github_email_missing");
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain(
        "Set a verified primary email in your GitHub settings",
      );
      expect(alert.textContent).not.toContain("github_email_missing");
    });

    it("shows err code verbatim for unknown error codes", () => {
      renderLogin("?err=unknown_error_code");
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("unknown_error_code");
    });

    // err 是 URL 里来的，谁都能给受害者递一条 /login?err=<任意一句话>。
    // 「未知码原样透出」的本意是透出一个**码**，不是让攻击者在我们自己的
    // 域名、自己的失败卡里写一句话——那是一条免费的钓鱼提示。
    it("refuses to echo an err value that is prose rather than a code", () => {
      renderLogin(
        "?err=" +
          encodeURIComponent(
            "Your account is locked. Call +1-555-0100 to restore access.",
          ),
      );
      const alert = screen.getByRole("alert");
      // 失败本身照说：标题和重试按钮都在
      expect(alert.textContent).toContain("Sign in unsuccessful");
      expect(
        screen.getByRole("button", { name: /Sign in again/i }),
      ).toBeTruthy();
      // 但那句话一个字都不许上屏
      expect(alert.textContent).not.toContain("+1-555-0100");
      expect(alert.textContent).not.toContain("Your account is locked");
    });

    it("failure alert has destructive-soft background", () => {
      renderLogin("?err=access_denied");
      const alert = screen.getByRole("alert");
      expect(alert.className).toContain("bg-destructive-soft");
    });
  });

  describe("Chinese locale", () => {
    beforeEach(async () => {
      await i18n.changeLanguage("zh-CN");
    });

    it("shows Chinese title", () => {
      renderLogin();
      expect(
        screen.getByRole("heading", { level: 1, name: /登录 AgentRe/ }),
      ).toBeTruthy();
    });

    it("shows context strip with Chinese label when user_code is present", () => {
      renderLogin("?user_code=A4F-7Q2");
      expect(screen.getByText(/登录后继续授权设备/)).toBeTruthy();
    });

    it("shows Chinese retry button on error", () => {
      renderLogin("?err=access_denied");
      expect(screen.getByRole("button", { name: /重新登录/ })).toBeTruthy();
    });

    it("shows Chinese error message for known err codes", () => {
      renderLogin("?err=access_denied");
      expect(screen.getByText(/取消了 GitHub 授权/)).toBeTruthy();
    });
  });

  describe("interaction", () => {
    it("retry button is clickable when error is shown", () => {
      renderLogin("?err=access_denied");
      const retryBtn = screen.getByRole("button", {
        name: /Sign in again/i,
      }) as HTMLButtonElement;
      expect(retryBtn.disabled).toBe(false);
    });
  });

  describe("passkey login", () => {
    it("shows passkey button when WebAuthn is supported", () => {
      // 浏览器支持时 window.PublicKeyCredential 存在
      Object.defineProperty(window, "PublicKeyCredential", {
        value: vi.fn(),
        writable: true,
        configurable: true,
      });

      renderLogin();
      expect(screen.getByRole("button", { name: /passkey/i })).toBeTruthy();
    });

    it("goes busy while the ceremony is in flight, so a second click cannot cancel the first", async () => {
      Object.defineProperty(window, "PublicKeyCredential", {
        value: function PublicKeyCredential() {},
        configurable: true,
        writable: true,
      });

      // begin 一直不回：这就是用户看着一颗没有任何反应的按钮的那段窗口。
      const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
      vi.stubGlobal("fetch", fetchMock);
      const get = vi.fn();
      vi.stubGlobal(
        "navigator",
        Object.create(navigator, { credentials: { value: { get } } }),
      );

      renderLogin();
      const btn = screen.getByRole("button", { name: /passkey/i });
      fireEvent.click(btn);

      // 第二次点击会让浏览器中止第一次 credentials.get，抛 NotAllowedError，
      // 被判成「用户取消」→ 一次本来会成功的登录被自己的第二次点击取消掉。
      await Promise.resolve();
      expect(
        (screen.getByRole("button", { name: /passkey/i }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: /passkey/i }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not show passkey button when WebAuthn is not supported", () => {
      // 浏览器不支持时 window.PublicKeyCredential 不存在
      Object.defineProperty(window, "PublicKeyCredential", {
        value: undefined,
        writable: true,
        configurable: true,
      });

      renderLogin();
      expect(screen.queryByRole("button", { name: /passkey/i })).toBeNull();
    });

    // Given 本站用 http 提供（源不是安全上下文，PublicKeyCredential 与
    // navigator.credentials 在那里整个不存在）/ When 打开登录页 / Then 不摆按钮，
    // 但要说清为什么。
    //
    // 此前这一整块是**静默消失**的：注册过通行密钥的人在这个部署上找不到入口，
    // 也读不到任何解释，只会以为功能没了。
    it("explains the http origin instead of dropping the passkey block silently", () => {
      Reflect.deleteProperty(window, "PublicKeyCredential");
      vi.spyOn(window, "isSecureContext", "get").mockReturnValue(false);

      renderLogin();
      expect(screen.queryByRole("button", { name: /passkey/i })).toBeNull();
      expect(screen.getByText(/only available over HTTPS/i)).toBeTruthy();
    });

    // 浏览器是真的老时保持沉默：那不是本站能替他解决的事，界面上也没有可执行的
    // 下一步——把「换成 https」摆给他看反而是句用不上的话。
    it("stays silent when the browser itself is too old", () => {
      Reflect.deleteProperty(window, "PublicKeyCredential");
      vi.spyOn(window, "isSecureContext", "get").mockReturnValue(true);

      renderLogin();
      expect(screen.queryByRole("button", { name: /passkey/i })).toBeNull();
      expect(screen.queryByText(/HTTPS/i)).toBeNull();
    });

    it("hides passkey button when error is shown", () => {
      // 错误态里隐藏通行密钥按钮，同 GitHub 按钮一样
      Object.defineProperty(window, "PublicKeyCredential", {
        value: vi.fn(),
        writable: true,
        configurable: true,
      });

      renderLogin("?err=access_denied");
      expect(screen.queryByRole("button", { name: /passkey/i })).toBeNull();
    });

    it("calls begin and finish endpoints in order without sending identifier", async () => {
      // 决策 10：登录不要求任何标识。验证点击按钮后的完整流程：
      // begin 请求 → navigator.credentials.get() → finish 请求 → 重定向到目标地址
      // 且所有请求都不含邮箱/用户名等标识（那是通行密钥的要点）
      //
      // 这条用例同时钉住两端的编解码，两处判据都取自真实的线格式：
      //  - begin 的回应是 cago 信封 `{code,msg,data}`，challenge / allowCredentials[].id
      //    是不带补位的 base64url **字符串**；喂给 navigator.credentials.get() 的
      //    必须已经是 ArrayBuffer（WebAuthn 的 IDL 声明成 BufferSource，字符串进去
      //    浏览器直接抛 TypeError）。
      //  - finish 的请求体反过来：浏览器给的是 ArrayBuffer，发出去的必须是 base64url
      //    字符串（后端 protocol.URLEncodedBase64 只认这个）。
      // 桩子只是「接住调用」的话这两件事一件都验不到——真实浏览器才会拒绝，
      // 所以这里把收到的参数原样接出来，在流程跑完之后逐字段断言。
      Object.defineProperty(window, "PublicKeyCredential", {
        value: vi.fn(),
        writable: true,
        configurable: true,
      });

      const CHALLENGE_B64URL = "31Ibesh_SMisD_nM7sSvnYsFpOP9K3hXVXmNKiXMU2g";
      const ALLOWED_ID_B64URL = "BwcHBwcH"; // 字节 [7,7,7,7,7,7]
      const CLIENT_DATA_B64URL = "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0"; // {"type":"webauthn.get"}
      const AUTH_DATA_B64URL = "oaKj"; // 字节 [0xa1,0xa2,0xa3]
      const SIGNATURE_B64URL = "-_8"; // 字节 [0xfb,0xff]，含 base64url 专属字母
      const USER_HANDLE_B64URL = "CQkJCQ"; // 字节 [9,9,9,9]

      const mockCredential = {
        id: ALLOWED_ID_B64URL,
        type: "public-key",
        rawId: b64urlToBufferForTest(ALLOWED_ID_B64URL),
        response: {
          clientDataJSON: b64urlToBufferForTest(CLIENT_DATA_B64URL),
          authenticatorData: b64urlToBufferForTest(AUTH_DATA_B64URL),
          signature: b64urlToBufferForTest(SIGNATURE_B64URL),
          userHandle: b64urlToBufferForTest(USER_HANDLE_B64URL),
        },
        getClientExtensionResults: () => ({}),
      };
      const callOrder: string[] = [];
      let beginBody: unknown = "not called";
      let finishBody: Record<string, never> | null = null;

      const fetchMock = vi.fn((url: string, opts: Record<string, unknown>) => {
        if (url === "/v1/passkeys/login/begin" && opts.method === "POST") {
          callOrder.push("begin");
          beginBody = opts.body;
          return Promise.resolve(
            new Response(
              // 真实回应带 cago 信封，publicKey 在 data 里面
              JSON.stringify({
                code: 0,
                msg: "success",
                data: {
                  publicKey: {
                    challenge: CHALLENGE_B64URL,
                    timeout: 300000,
                    rpId: "localhost",
                    userVerification: "preferred",
                    allowCredentials: [
                      { type: "public-key", id: ALLOWED_ID_B64URL },
                    ],
                  },
                },
              }),
            ),
          );
        }
        if (url === "/v1/passkeys/login/finish" && opts.method === "POST") {
          callOrder.push("finish");
          finishBody = JSON.parse(opts.body as string);
          return Promise.resolve(
            new Response(JSON.stringify({ code: 0, msg: "success", data: {} })),
          );
        }
        return Promise.reject(new Error(`Unexpected fetch: ${url}`));
      });

      vi.stubGlobal("fetch", fetchMock);

      // 假认证器按浏览器的规矩挑参数：喂进去的 challenge / allowCredentials[].id
      // 还是字符串时当场 TypeError，而不是不看参数地兑现。
      const get = vi.fn(fakeCredentialsGet(mockCredential));
      vi.stubGlobal(
        "navigator",
        Object.create(navigator, { credentials: { value: { get } } }),
      );

      renderLogin();
      const passkeyBtn = screen.getByRole("button", { name: /passkey/i });
      fireEvent.click(passkeyBtn);

      // 等待异步操作完成
      await new Promise((resolve) => setTimeout(resolve, 100));

      // 登录成功后重定向，两个端点都被调用且顺序正确
      expect(callOrder).toEqual(["begin", "finish"]);
      expect(window.location.assign).toHaveBeenCalledWith("/");

      // begin 请求不含任何请求体
      expect(beginBody).toBeUndefined();

      // ── 去程：navigator.credentials.get() 收到的必须是 ArrayBuffer ──
      const passed = get.mock.calls[0][0].publicKey;
      expect(typeof passed.challenge).not.toBe("string");
      expect(passed.challenge instanceof ArrayBuffer).toBe(true);
      expect(new Uint8Array(passed.challenge)).toEqual(
        new Uint8Array(b64urlToBufferForTest(CHALLENGE_B64URL)),
      );
      const allowed = passed.allowCredentials[0];
      expect(typeof allowed.id).not.toBe("string");
      expect(allowed.id instanceof ArrayBuffer).toBe(true);
      expect(new Uint8Array(allowed.id)).toEqual(
        new Uint8Array(b64urlToBufferForTest(ALLOWED_ID_B64URL)),
      );
      // 不是 buffer 的字段原样带过
      expect(passed.rpId).toBe("localhost");
      expect(passed.userVerification).toBe("preferred");

      // ── 回程：finish 的请求体必须是 base64url 字符串 ──
      const body = finishBody as unknown as {
        credential: {
          id: string;
          type: string;
          rawId: string;
          response: Record<string, string>;
        };
      };
      // 只有 credential，没有标识字段
      expect(Object.keys(body)).toEqual(["credential"]);
      const credential = body.credential;
      expect(credential.id).toBe(ALLOWED_ID_B64URL);
      expect(credential.type).toBe("public-key");
      expect(credential.rawId).toBe(ALLOWED_ID_B64URL);
      expect(credential.response.clientDataJSON).toBe(CLIENT_DATA_B64URL);
      expect(credential.response.authenticatorData).toBe(AUTH_DATA_B64URL);
      expect(credential.response.signature).toBe(SIGNATURE_B64URL);
      expect(credential.response.userHandle).toBe(USER_HANDLE_B64URL);
      // ArrayBuffer 忘了编码时 JSON.stringify 会把它变成 `{}`，
      // 逐字段验类型是唯一能把那种沉默走形拦住的断言。
      for (const value of Object.values(credential.response)) {
        expect(typeof value).toBe("string");
        expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
      }
    });

    it("shows calm retry message when user cancels credential prompt", async () => {
      // 「用户取消」不是报错，只是平和的重试提示（决策 17）。
      // NotAllowedError 从浏览器来，显示成 secondary-soft（非 destructive）。
      Object.defineProperty(window, "PublicKeyCredential", {
        value: vi.fn(),
        writable: true,
        configurable: true,
      });

      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                code: 0,
                msg: "success",
                data: { publicKey: { challenge: "AQID" } },
              }),
            ),
          ),
        ),
      );

      // navigator.credentials.get() 抛 NotAllowedError（用户点了取消）
      vi.stubGlobal(
        "navigator",
        Object.create(navigator, {
          credentials: {
            value: {
              // 先按浏览器的规矩挑参数、再抛取消：不这样写的话，取消这条路上的
              // 去程编码（challenge 解成 ArrayBuffer）一个字都没被验到。
              get: vi.fn(
                fakeCredentialsGet(() => {
                  throw new DOMException("User cancelled", "NotAllowedError");
                }),
              ),
            },
          },
        }),
      );

      renderLogin();
      const passkeyBtn = screen.getByRole("button", { name: /passkey/i });
      fireEvent.click(passkeyBtn);

      // 等待异步操作和重定向完成
      await new Promise((resolve) => setTimeout(resolve, 100));

      // 重定向到 /login?err=passkey_cancelled
      expect(window.location.assign).toHaveBeenCalledWith(
        expect.stringContaining("err=passkey_cancelled"),
      );

      // 重新渲染：取消这条路走的是平和提示，不是失败卡。
      // 先 cleanup 掉上一次渲染——不清，两份 Login 同时挂在 document 上，
      // 下面「失败卡不该出现」之类的否定断言就会在第一份上撞见同名节点。
      vi.clearAllMocks();
      cleanup();
      renderLogin("?err=passkey_cancelled");

      // 断言只落在**渲染出来的东西**上，不落在 class 属性上：
      // `document.querySelector(".bg-secondary-soft")` 匹配的是 DOM 里那串
      // 字符，不管 Tailwind 有没有为它生成过任何规则——用一个没声明的 token
      // 也照样是绿的（本轮的 bg-secondary-soft 就是这么漏过去的，token 用法
      // 本身由 design-token-contract 那条守卫钉住）。
      expect(screen.getByText(/Check cancelled/i)).toBeTruthy();

      // 失败卡的三件套一个都不该出现：标题、重试按钮、以及「只剩重试」这个形态
      // ——取消之后两条登录入口都该还在，用户可以直接再按一次。
      expect(screen.queryByText("Sign in unsuccessful")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Sign in again" }),
      ).toBeNull();
      expect(screen.getByRole("button", { name: /GitHub/i })).toBeTruthy();
      expect(screen.getByRole("button", { name: /passkey/i })).toBeTruthy();
    });

    // 规格「通行密钥 · 失败」：「每一种给各自的错误码与文案，不压成一句
    // 「登录失败」」。后端的裁决是信封里那个**数字**业务码；前端要分支就必须
    // 读 ApiError.code，把它翻成自己这条路上的 err 码。
    it.each([
      ["PasskeyChallengeInvalid", 30601, "passkey_challenge_invalid"],
      ["PasskeyOriginNotAllowed", 30605, "passkey_origin_not_allowed"],
      ["PasskeyCredentialUnknown", 30606, "passkey_credential_unknown"],
      ["PasskeyCounterRollback", 30607, "passkey_counter_rollback"],
      ["UserBanned", 30101, "user_banned"],
    ])(
      "maps backend %s to its own err code instead of one collapsed failure",
      async (_name, envelopeCode, expectedErr) => {
        Object.defineProperty(window, "PublicKeyCredential", {
          value: vi.fn(),
          writable: true,
          configurable: true,
        });
        vi.stubGlobal(
          "fetch",
          vi.fn((url: string) =>
            Promise.resolve(
              url === "/v1/passkeys/login/begin"
                ? new Response(
                    JSON.stringify({
                      code: 0,
                      msg: "success",
                      data: {
                        publicKey: {
                          challenge: "AQID",
                          rpId: "localhost",
                          userVerification: "preferred",
                          allowCredentials: [
                            { type: "public-key", id: "BwcHBwcH" },
                          ],
                        },
                      },
                    }),
                  )
                : new Response(
                    JSON.stringify({ code: envelopeCode, msg: "", data: null }),
                    { status: 401 },
                  ),
            ),
          ),
        );
        vi.stubGlobal(
          "navigator",
          Object.create(navigator, {
            credentials: {
              value: {
                get: vi.fn(
                  fakeCredentialsGet({
                    id: "BwcHBwcH",
                    type: "public-key",
                    rawId: b64urlToBufferForTest("BwcHBwcH"),
                    response: {
                      clientDataJSON: b64urlToBufferForTest("AQID"),
                      authenticatorData: b64urlToBufferForTest("AQID"),
                      signature: b64urlToBufferForTest("AQID"),
                    },
                    getClientExtensionResults: () => ({}),
                  }),
                ),
              },
            },
          }),
        );

        renderLogin();
        fireEvent.click(screen.getByRole("button", { name: /passkey/i }));
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(window.location.assign).toHaveBeenCalledWith(
          expect.stringContaining("err=" + expectedErr),
        );
      },
    );

    // 规格「通行密钥 · 失败」的另一半：文案。err 码没有 locale 条目时
    // Login 的兜底分支会把码**原样**印进失败卡，用户读到的是
    // `passkey_failed` 这样一串标识符。
    it.each([
      "passkey_failed",
      "passkey_challenge_invalid",
      "passkey_origin_not_allowed",
      "passkey_credential_unknown",
      "passkey_counter_rollback",
    ])("renders translated copy for %s, never the bare code", (errCode) => {
      renderLogin("?err=" + errCode);
      const alert = screen.getByRole("alert");
      expect(alert.textContent).not.toContain(errCode);
    });
  });
});
