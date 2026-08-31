import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import i18n from "@/i18n";
import {
  assertValidCreationOptions,
  b64urlToBuffer as b64urlToBufferForTest,
  type ObservedCreationOptions,
} from "@/test/webauthn";
import Account from "@/pages/Account";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

/**
 * 规格「用户菜单与 /account」：三张卡（账号 / 通行密钥 / 登录会话），单列纵向
 * 堆叠，桌面与移动同一条流；空态走共享 EmptyState；删除密钥与登出其它全部都
 * 要二次确认；UA 原样展示、整行可点展开/收起，展开态属于该行自己；不支持
 * WebAuthn 时「添加通行密钥」禁用并给出理由，空态换成不含行动号召的措辞。
 * 全部数据虚构，账号「林薇」不对应任何真人（沿用 mockup 数据集）。
 */

const ME = {
  user_id: 1,
  email: "lin.wei@example.com",
  display_name: "林薇",
  avatar_url: "",
  github_login: "linwei",
  csrf_token: "csrf-token",
};

const PASSKEYS = {
  passkeys: [
    {
      id: 1,
      name: "工作 MacBook",
      created_at: 1754000000000,
      last_used_at: 1754500000000,
    },
    {
      id: 2,
      name: "YubiKey 5C",
      created_at: 1754100000000,
      last_used_at: 0,
    },
  ],
};

const UA_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const UA_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

const SESSIONS = {
  sessions: [
    {
      user_agent: UA_DESKTOP,
      ip: "203.0.113.24",
      created_at: 1755000000000,
      last_active_at: 1755100000000,
      current: true,
    },
    {
      user_agent: UA_MOBILE,
      ip: "198.51.100.7",
      created_at: 1754000000000,
      last_active_at: 1754100000000,
      current: false,
    },
  ],
};

const ONLY_CURRENT = { sessions: [SESSIONS.sessions[0]] };

function renderAccount() {
  return render(
    <MemoryRouter>
      <Account />
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
}

function mockDefaultApi() {
  mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/v1/auth/me") return ME;
    if (path === "/v1/passkeys" && (!init || (init.method ?? "GET") === "GET"))
      return PASSKEYS;
    if (path === "/v1/auth/sessions") return SESSIONS;
    throw new Error(`unexpected call: ${path} ${init?.method ?? "GET"}`);
  });
}

let hadPublicKeyCredential: boolean;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  hadPublicKeyCredential = "PublicKeyCredential" in window;
  // 默认视为不支持通行密钥；每个「支持」场景自己声明。
  Reflect.deleteProperty(window, "PublicKeyCredential");
});

afterEach(() => {
  // isSecureContext 那条用 spyOn 换掉取值器，不还原会活到后面的用例里。
  vi.restoreAllMocks();
  // beforeEach 无条件删掉了这个属性，所以「本来就没有」的那一支已经没什么可做；
  // 要还原的恰恰是「本来有」的那一支——原来的判据写反了，于是唯一需要还原的情形
  // 从来没被还原过。
  if (hadPublicKeyCredential) {
    Object.defineProperty(window, "PublicKeyCredential", {
      value: function PublicKeyCredential() {},
      writable: true,
      configurable: true,
    });
  } else {
    Reflect.deleteProperty(window, "PublicKeyCredential");
  }
});

function markWebauthnSupported() {
  Object.defineProperty(window, "PublicKeyCredential", {
    value: function PublicKeyCredential() {},
    configurable: true,
    writable: true,
  });
}

describe("Account page: three cards render real data", () => {
  it("renders the account card, passkey list and session list from their own endpoints", async () => {
    markWebauthnSupported();
    mockDefaultApi();
    renderAccount();

    // 显示名 / 邮箱在左下角用户菜单里也会出现一份，查询范围限定在 /account 正文。
    const page = await screen.findByTestId("account-page");
    expect(within(page).getByText("林薇")).toBeTruthy();
    expect(within(page).getByText("lin.wei@example.com")).toBeTruthy();
    expect(within(page).getByText("linwei")).toBeTruthy();

    expect(await screen.findByText("工作 MacBook")).toBeTruthy();
    expect(screen.getByText("YubiKey 5C")).toBeTruthy();
    expect(screen.getByText(/Never used/)).toBeTruthy();

    expect(screen.getByText("203.0.113.24")).toBeTruthy();
    expect(screen.getByText("198.51.100.7")).toBeTruthy();
    expect(screen.getByText("This session")).toBeTruthy();

    expect(mockedApi).toHaveBeenCalledWith("/v1/passkeys");
    expect(mockedApi).toHaveBeenCalledWith("/v1/auth/sessions");
  });

  it("does not parse the UA into a friendly label — the verbatim string is always in the DOM", async () => {
    markWebauthnSupported();
    mockDefaultApi();
    renderAccount();
    // 完整原文必须找得到（截断只是 CSS），不是「Chrome on macOS」这类合成文案。
    expect(await screen.findByText(UA_DESKTOP)).toBeTruthy();
    expect(screen.getByText(UA_MOBILE)).toBeTruthy();
    expect(screen.queryByText(/Chrome on /i)).toBeNull();
    expect(screen.queryByText(/on macOS/i)).toBeNull();
  });
});

describe("Account page: passkey deletion and sign-out-elsewhere are confirmed twice", () => {
  it("deleting a passkey opens a confirmation and only calls DELETE after it is confirmed", async () => {
    markWebauthnSupported();
    let deleted = false;
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/v1/auth/me") return ME;
      if (path === "/v1/auth/sessions") return SESSIONS;
      if (
        path === "/v1/passkeys" &&
        (!init || (init.method ?? "GET") === "GET")
      ) {
        return deleted ? { passkeys: [PASSKEYS.passkeys[1]] } : PASSKEYS;
      }
      if (path === "/v1/passkeys/1" && init?.method === "DELETE") {
        deleted = true;
        return {};
      }
      throw new Error(`unexpected call: ${path} ${init?.method ?? "GET"}`);
    });
    renderAccount();

    const row = (await screen.findByText("工作 MacBook")).closest(
      "li",
    ) as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/工作 MacBook/)).toBeTruthy();
    // 打开确认框本身不能已经发出删除请求。
    expect(mockedApi).not.toHaveBeenCalledWith(
      "/v1/passkeys/1",
      expect.objectContaining({ method: "DELETE" }),
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        "/v1/passkeys/1",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByText("工作 MacBook")).toBeNull();
    });
  });

  it("cancelling the passkey delete confirmation leaves the passkey and calls no endpoint", async () => {
    markWebauthnSupported();
    mockDefaultApi();
    renderAccount();

    const row = (await screen.findByText("YubiKey 5C")).closest(
      "li",
    ) as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("YubiKey 5C")).toBeTruthy();
    // 按 path 自己比，不用 expect.anything()：那个匹配器要求第二个实参**存在
    // 且非 null**，因此一次 `api("/v1/passkeys/2")` 的单参调用根本匹配不上，
    // 断言照样是绿的——而单参调用正是这里要挡住的那种删除。
    expect(mockedApi.mock.calls.some((c) => c[0] === "/v1/passkeys/2")).toBe(
      false,
    );
  });

  it("signing out other sessions opens a confirmation and only calls revoke-others after it is confirmed", async () => {
    markWebauthnSupported();
    let revoked = false;
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/v1/auth/me") return ME;
      if (path === "/v1/passkeys") return PASSKEYS;
      if (path === "/v1/auth/sessions")
        return revoked ? ONLY_CURRENT : SESSIONS;
      if (
        path === "/v1/auth/sessions/revoke-others" &&
        init?.method === "POST"
      ) {
        revoked = true;
        return { revoked: 1 };
      }
      throw new Error(`unexpected call: ${path} ${init?.method ?? "GET"}`);
    });
    renderAccount();

    const button = await screen.findByRole("button", {
      name: "Sign out everywhere else",
    });
    fireEvent.click(button);

    const dialog = await screen.findByRole("dialog");
    expect(
      mockedApi.mock.calls.some(
        (c) => c[0] === "/v1/auth/sessions/revoke-others",
      ),
    ).toBe(false);

    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Sign out everywhere else",
      }),
    );

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        "/v1/auth/sessions/revoke-others",
        expect.objectContaining({ method: "POST" }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByText(UA_MOBILE)).toBeNull();
    });
    expect(await screen.findByText("This is your only session.")).toBeTruthy();
  });

  it("hides the sign-out-everywhere-else action when there is only the current session", async () => {
    markWebauthnSupported();
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/me") return ME;
      if (path === "/v1/passkeys") return PASSKEYS;
      if (path === "/v1/auth/sessions") return ONLY_CURRENT;
      throw new Error(`unexpected call: ${path}`);
    });
    renderAccount();

    expect(await screen.findByText("This is your only session.")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Sign out everywhere else" }),
    ).toBeNull();
  });
});

describe("Account page: a session row expands and collapses on click, per row", () => {
  it("expands the clicked row to the full UA and leaves the other row collapsed, then collapses again on a second click", async () => {
    markWebauthnSupported();
    mockDefaultApi();
    renderAccount();

    const desktopButton = (await screen.findByText(UA_DESKTOP)).closest(
      "button",
    ) as HTMLElement;
    const mobileButton = screen
      .getByText(UA_MOBILE)
      .closest("button") as HTMLElement;

    expect(desktopButton.getAttribute("aria-expanded")).toBe("false");
    expect(mobileButton.getAttribute("aria-expanded")).toBe("false");
    const desktopSpanBefore = within(desktopButton).getByText(UA_DESKTOP);
    expect(desktopSpanBefore.className).toContain("truncate");

    fireEvent.click(desktopButton);

    expect(desktopButton.getAttribute("aria-expanded")).toBe("true");
    // 另一行不受影响：展开态只属于被点的那一行。
    expect(mobileButton.getAttribute("aria-expanded")).toBe("false");
    const desktopSpanAfter = within(desktopButton).getByText(UA_DESKTOP);
    expect(desktopSpanAfter.className).toContain("break-all");
    expect(desktopSpanAfter.className).not.toContain("truncate");

    fireEvent.click(desktopButton);
    expect(desktopButton.getAttribute("aria-expanded")).toBe("false");
    expect(within(desktopButton).getByText(UA_DESKTOP).className).toContain(
      "truncate",
    );
  });

  it("centers the icon on the two-line block when collapsed, and pins it to the top when the UA wraps", async () => {
    markWebauthnSupported();
    mockDefaultApi();
    renderAccount();

    const desktopButton = (await screen.findByText(UA_DESKTOP)).closest(
      "button",
    ) as HTMLElement;
    const ua = within(desktopButton).getByText(UA_DESKTOP);
    const iconClass = () =>
      desktopButton.querySelector("svg")?.getAttribute("class") ?? "";

    // 折叠态与通行密钥行同一套：图标相对两行块垂直居中，UA 是标题级尺寸，
    // 元信息才是 11px。两行都走 text-xs 的话看起来像同一句描述印了两遍，
    // items-start 又把 16px 图标钉在被 StatusMark 撑高的第一行顶部。
    expect(desktopButton.className).toContain("items-center");
    expect(desktopButton.className).not.toContain("items-start");
    expect(iconClass()).not.toContain("mt-0.5");
    expect(ua.className).toContain("text-aux");

    fireEvent.click(desktopButton);

    // 展开后 UA 折成多行，图标改钉在顶部，避免悬在折行块的垂直中线。
    expect(desktopButton.className).toContain("items-start");
    expect(iconClass()).toContain("mt-0.5");
  });
});

describe("Account page: unsupported browsers disable add and change the empty-state wording", () => {
  it("disables Add a passkey with a reason when window.PublicKeyCredential is absent", async () => {
    mockDefaultApi();
    renderAccount();

    const addButton = (await screen.findByRole("button", {
      name: /Add a passkey/i,
    })) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);
    expect(addButton.getAttribute("title")).toMatch(
      /does not support passkeys/i,
    );
  });

  // Given 本站用 http 提供 / When 打开账号页 / Then 说的是这个源，不是浏览器。
  //
  // 此前这里一律写「这个浏览器不支持通行密钥 · 换用较新的 Chrome、Safari 或 Edge
  // 即可添加」——浏览器支持得好好的，用户照着换几个都一样。
  it("blames the http origin, not the browser, when the page is not a secure context", async () => {
    vi.spyOn(window, "isSecureContext", "get").mockReturnValue(false);
    mockDefaultApi();
    renderAccount();

    const addButton = (await screen.findByRole("button", {
      name: /Add a passkey/i,
    })) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);
    expect(addButton.getAttribute("title")).toMatch(/HTTPS/i);
    expect(addButton.getAttribute("title")).not.toMatch(/does not support/i);
    expect(screen.getByText(/served over HTTP/i)).toBeTruthy();
    expect(screen.queryByText(/does not support passkeys/i)).toBeNull();
  });

  it("enables Add a passkey when window.PublicKeyCredential is present", async () => {
    markWebauthnSupported();
    mockDefaultApi();
    renderAccount();

    const addButton = (await screen.findByRole("button", {
      name: /Add a passkey/i,
    })) as HTMLButtonElement;
    expect(addButton.disabled).toBe(false);
  });

  it("switches the empty passkeys state to no-call-to-action wording when unsupported", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/me") return ME;
      if (path === "/v1/passkeys") return { passkeys: [] };
      if (path === "/v1/auth/sessions") return SESSIONS;
      throw new Error(`unexpected call: ${path}`);
    });
    renderAccount();

    expect(
      await screen.findByText(/switch to a browser that supports passkeys/i),
    ).toBeTruthy();
    // 不含号召此刻做不到的动作那句（决策 18）。
    expect(screen.queryByText(/get in when GitHub is down/i)).toBeNull();
  });

  it("keeps the invite-to-add wording when supported and there are no passkeys yet", async () => {
    markWebauthnSupported();
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/me") return ME;
      if (path === "/v1/passkeys") return { passkeys: [] };
      if (path === "/v1/auth/sessions") return SESSIONS;
      throw new Error(`unexpected call: ${path}`);
    });
    renderAccount();

    expect(await screen.findByText(/get in when GitHub is down/i)).toBeTruthy();
  });

  it("opens the naming dialog when Add a passkey is clicked while supported", async () => {
    markWebauthnSupported();
    mockDefaultApi();
    renderAccount();

    fireEvent.click(
      await screen.findByRole("button", { name: /Add a passkey/i }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByPlaceholderText(/Work MacBook/)).toBeTruthy();
  });
});

describe("Account page: no horizontal overflow at 390 (structural — jsdom computes no layout)", () => {
  it("stacks the three cards in a single vertical column with no row breakpoint", async () => {
    markWebauthnSupported();
    mockDefaultApi();
    renderAccount();
    const root = await screen.findByTestId("account-page");
    expect(root.className).toContain("flex-col");
    expect(root.className).not.toMatch(/\bflex-row\b/);
  });

  it("truncates long identifiers instead of letting them force width", async () => {
    markWebauthnSupported();
    mockDefaultApi();
    renderAccount();
    const page = await screen.findByTestId("account-page");
    expect(within(page).getByText("lin.wei@example.com").className).toContain(
      "truncate",
    );
    expect(within(page).getByText("linwei").className).toContain("truncate");
  });
});

describe("Account page: registering a passkey performs the WebAuthn ceremony correctly", () => {
  it("decodes the begin options, calls navigator.credentials.create, and re-encodes the response for finish", async () => {
    markWebauthnSupported();
    const CHALLENGE_B64URL = "AQIDBAX6-w"; // bytes [1,2,3,4,5,250,251]
    const USER_ID_B64URL = "CQkJCQ"; // bytes [9,9,9,9]
    const NEW_CRED_ID_B64URL = "BwcHBwcH"; // bytes [7,7,7,7,7,7]
    const EXISTING_CRED_ID_B64URL = "CwsLCws"; // bytes [11,11,11,11,11]
    const ATTESTATION_OBJECT_B64URL = "oaKj"; // bytes [0xa1,0xa2,0xa3]
    const CLIENT_DATA_B64URL = "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0"; // {"type":"webauthn.create"}

    const beginOptions = {
      rp: { id: "agentre.example", name: "AgentRe" },
      user: {
        id: USER_ID_B64URL,
        name: "lin.wei@example.com",
        displayName: "林薇",
      },
      challenge: CHALLENGE_B64URL,
      // 已有凭证要一并解码：漏了这一层，浏览器在 excludeCredentials[].id 上抛
      // TypeError，「同一把认证器不许注册两次」那道提示也就整个失效。
      excludeCredentials: [{ type: "public-key", id: EXISTING_CRED_ID_B64URL }],
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      attestation: "none",
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "preferred",
      },
    };

    const fakeCredential = {
      id: "new-cred",
      type: "public-key",
      rawId: b64urlToBufferForTest(NEW_CRED_ID_B64URL),
      response: {
        attestationObject: b64urlToBufferForTest(ATTESTATION_OBJECT_B64URL),
        clientDataJSON: b64urlToBufferForTest(CLIENT_DATA_B64URL),
      },
      getClientExtensionResults: () => ({}),
    };

    // 假认证器按浏览器的规矩挑参数。不挑的话，production 把服务端原文原样透传
    // （challenge 还是 base64url 字符串）这条必然失败的路径在用例里一路绿灯。
    const create = vi.fn((arg: ObservedCreationOptions) => {
      assertValidCreationOptions(arg);
      return Promise.resolve(fakeCredential);
    });
    Object.defineProperty(window.navigator, "credentials", {
      value: { create },
      configurable: true,
    });

    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/v1/auth/me") return ME;
      if (path === "/v1/auth/sessions") return SESSIONS;
      if (
        path === "/v1/passkeys" &&
        (!init || (init.method ?? "GET") === "GET")
      )
        return PASSKEYS;
      if (path === "/v1/passkeys/register/begin" && init?.method === "POST")
        return { publicKey: beginOptions };
      if (path === "/v1/passkeys/register/finish" && init?.method === "POST") {
        return {
          passkey: {
            id: 3,
            name: JSON.parse(String(init.body)).name,
            created_at: 1756000000000,
            last_used_at: 0,
          },
        };
      }
      throw new Error(`unexpected call: ${path} ${init?.method ?? "GET"}`);
    });

    renderAccount();
    fireEvent.click(
      await screen.findByRole("button", { name: /Add a passkey/i }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText(/Work MacBook/), {
      target: { value: "My New Key" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const passedOptions = create.mock.calls[0][0].publicKey;
    expect(new Uint8Array(passedOptions.challenge)).toEqual(
      new Uint8Array([1, 2, 3, 4, 5, 250, 251]),
    );
    expect(new Uint8Array(passedOptions.user.id)).toEqual(
      new Uint8Array([9, 9, 9, 9]),
    );
    expect(new Uint8Array(passedOptions.excludeCredentials[0].id)).toEqual(
      new Uint8Array([11, 11, 11, 11, 11]),
    );
    // 可发现凭证（决策 10）：登录不要求任何标识，全靠认证器自己记得住这把密钥
    // 属于谁。解码时把 authenticatorSelection 丢掉，注册出来的就是一把普通凭证
    // ——通行密钥登录从此静默失效，而清单上看不出任何区别。
    expect(passedOptions.authenticatorSelection).toEqual({
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "preferred",
    });
    // RP 与算法列表同样必须原样带过：少了 rp.id 浏览器按当前域推断，少了
    // pubKeyCredParams 直接 TypeError。
    expect(passedOptions.rp).toEqual({
      id: "agentre.example",
      name: "AgentRe",
    });
    expect(passedOptions.pubKeyCredParams).toEqual([
      { type: "public-key", alg: -7 },
    ]);

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        "/v1/passkeys/register/finish",
        expect.objectContaining({ method: "POST" }),
      );
    });
    const finishCall = mockedApi.mock.calls.find(
      (c) => c[0] === "/v1/passkeys/register/finish",
    ) as [string, RequestInit];
    const body = JSON.parse(String(finishCall[1].body));
    expect(body.name).toBe("My New Key");
    expect(body.credential.rawId).toBe(NEW_CRED_ID_B64URL);
    expect(body.credential.response.attestationObject).toBe(
      ATTESTATION_OBJECT_B64URL,
    );
    expect(body.credential.response.clientDataJSON).toBe(CLIENT_DATA_B64URL);

    expect(await screen.findByText("My New Key")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // 刚加的那把排在最前面：服务端的清单是 id DESC（webauthn_credential_repo
    // .ListByUser 的注释写明「最近添加的在前」）。本地把它追加到末尾的话，用户
    // 加完看到它在最后一行，刷新一次又跳到第一行——同一份清单两种次序。
    const names = screen
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
    expect(names[0]).toContain("My New Key");
  });
});
