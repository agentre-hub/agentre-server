/**
 * 打开 App 与身份（规格 2026-11-25 决策 A2、A3、A4、A6）：
 *   - 只有 401 才去登录页，并且先清空本地；网络错误、超时、5xx、门户页都不算；
 *   - 有本地身份时不等 /auth/me 就进入，核对失败留在 App，页头下「网络不稳定」细条，
 *     退避重试，联网 / 回前台立即重试；
 *   - 没有本地身份且取不到：整屏「连不上服务器」+「正在自动重试 · 第 N 次」+「立即重试」，
 *     取到即进入；
 *   - 身份换成另一个账号：清空上一个账号的数据；
 *   - 身份全局只取一次。
 *
 * IndexedDB 用 fake-indexeddb，每条用例一份新的；本地身份由用例自己先写进去，等于
 * 「上次在这台手机上用过」。
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AppShell from "@/components/AppShell";
import RequireAuth from "@/components/RequireAuth";
import { useMe, type Me } from "@/hooks/use-me";
import i18n from "@/i18n";
import { api, ApiError, ApiTimeoutError } from "@/lib/api";
import {
  accountStore,
  bindAccount,
  readLocalIdentity,
  writeLocalIdentity,
} from "@/lib/localStore";
import { signOut } from "@/lib/signOut";
import { ThemeProvider } from "@agentre-hub/agentre-ui";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

vi.mock("@/lib/accountChannel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountChannel")>();
  return { ...actual, startAccountChannel: vi.fn(() => ({ stop: () => {} })) };
});

const mockedApi = vi.mocked(api);
const g = globalThis as Record<string, unknown>;

const ME: Me = {
  user_id: 1,
  email: "one@agentre.dev",
  display_name: "One",
  avatar_url: "",
  github_login: "one",
  csrf_token: "csrf-one",
};

const OTHER: Me = {
  user_id: 2,
  email: "two@agentre.dev",
  display_name: "Two",
  avatar_url: "",
  github_login: "two",
  csrf_token: "csrf-two",
};

/** /auth/me 依次怎么答；其余请求一律失败（外壳的锦上添花数据取不到就不画）。 */
function answerMe(...answers: Array<() => Promise<unknown>>) {
  let i = 0;
  mockedApi.mockImplementation(async (path: string) => {
    if (path === "/v1/auth/me") {
      const answer = answers[Math.min(i, answers.length - 1)];
      i += 1;
      return answer();
    }
    throw new ApiError(30001, "not under test", 500);
  });
}

const meCalls = () =>
  mockedApi.mock.calls.filter(([path]) => path === "/v1/auth/me").length;

const resolves = (me: Me) => () => Promise.resolve(me);
const rejects = (err: unknown) => () => Promise.reject(err);
const never = () => new Promise<never>(() => {});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 退避要用假时钟，但假时钟下不用 findBy* / waitFor：testing-library 收尾时要跑一个真
 * setTimeout，与被冻住的时钟互相等（devices.test.tsx 同一做法）。所以先在真时钟下走到
 * 「第一次核对在飞」，再换假时钟、放出那一次的结果，之后「推时钟 + 同步查询」。
 */
function fakeClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const UNSTABLE = "Network unstable · showing earlier content, retrying";

function renderApp() {
  return render(
    <MemoryRouter initialEntries={["/chat?x=1"]}>
      <ThemeProvider>
        <RequireAuth>
          <AppShell title="Page">page body</AppShell>
        </RequireAuth>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

async function seedLocal(me: Me) {
  await writeLocalIdentity(me);
  bindAccount(me.user_id);
  await accountStore.put("list", "all", [`rows of ${me.user_id}`]);
  bindAccount(null);
}

const realLocation = window.location;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  g.indexedDB = new IDBFactory();
  g.IDBKeyRange = IDBKeyRange;
  mockedApi.mockReset();
  sessionStorage.clear();
  Object.defineProperty(window, "location", {
    value: { ...realLocation, replace: vi.fn(), assign: vi.fn() },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete g.indexedDB;
  delete g.IDBKeyRange;
  Object.defineProperty(window, "location", {
    value: realLocation,
    writable: true,
    configurable: true,
  });
});

describe("有本地身份", () => {
  it("不等 /auth/me 就进入，CSRF 也先从本地身份接上", async () => {
    await seedLocal(ME);
    answerMe(never);

    renderApp();

    expect(await screen.findByText("page body")).toBeTruthy();
    expect(screen.queryByText(UNSTABLE)).toBeNull();
    expect(sessionStorage.getItem("csrf")).toBe(ME.csrf_token);
  });

  it.each([
    ["断网", new TypeError("Failed to fetch")],
    ["超时", new ApiTimeoutError("/v1/auth/me", 15_000)],
    ["5xx", new ApiError(30001, "bad gateway", 502)],
    ["门户页（不是 JSON）", new SyntaxError("Unexpected token '<'")],
  ])(
    "核对失败（%s）：留在 App，页头下「网络不稳定」，退避重试，取到就收起",
    async (_name, err) => {
      await seedLocal(ME);
      const first = deferred<Me>();
      answerMe(() => first.promise, resolves(ME));

      renderApp();
      await screen.findByText("page body");
      await waitFor(() => expect(meCalls()).toBe(1));

      fakeClock();
      first.reject(err);
      await advance(0);

      expect(screen.getByText(UNSTABLE)).toBeTruthy();
      expect(screen.getByText("page body")).toBeTruthy();
      expect(window.location.replace).not.toHaveBeenCalled();
      expect(meCalls()).toBe(1);

      await advance(1_000);

      expect(meCalls()).toBe(2);
      expect(screen.queryByText(UNSTABLE)).toBeNull();
      expect(screen.getByText("page body")).toBeTruthy();
    },
  );

  it("核对 401：先清空本地（身份、业务数据、CSRF 副本），再去登录页并带上原地址", async () => {
    await seedLocal(ME);
    answerMe(rejects(new ApiError(30004, "unauthorized", 401)));
    let identityAtRedirect: unknown = "not redirected";
    vi.mocked(window.location.replace).mockImplementation(() => {
      void readLocalIdentity().then((v) => {
        identityAtRedirect = v;
      });
    });

    renderApp();

    await waitFor(() =>
      expect(window.location.replace).toHaveBeenCalledWith(
        "/login?next=" + encodeURIComponent("/chat?x=1"),
      ),
    );
    await waitFor(() => expect(identityAtRedirect).toBeUndefined());
    bindAccount(ME.user_id);
    expect(await accountStore.get("list", "all")).toBeUndefined();
    bindAccount(null);
    expect(sessionStorage.getItem("csrf")).toBeNull();
  });

  it("身份换成另一个账号：上一个账号的业务数据清掉，按新账号进入", async () => {
    await seedLocal(ME);
    answerMe(resolves(OTHER));

    renderApp();

    await waitFor(async () =>
      expect(await readLocalIdentity()).toMatchObject({ user_id: 2 }),
    );
    bindAccount(ME.user_id);
    expect(await accountStore.get("list", "all")).toBeUndefined();
    bindAccount(null);
    expect(sessionStorage.getItem("csrf")).toBe(OTHER.csrf_token);
    expect(screen.getByText("page body")).toBeTruthy();
    expect(window.location.replace).not.toHaveBeenCalled();
  });

  it("App 里任何别的请求回 401：同样清空并去登录页", async () => {
    await seedLocal(ME);
    answerMe(resolves(ME));
    renderApp();
    await screen.findByText("page body");
    await waitFor(async () =>
      expect(sessionStorage.getItem("csrf")).toBe(ME.csrf_token),
    );

    // 走真正的 api()：401 的判定在它那一层，不在调用方。
    const actual =
      await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { code: 30004, msg: "unauthorized", data: null },
          { status: 401 },
        ),
      ),
    );
    try {
      await expect(actual.api("/v1/devices")).rejects.toMatchObject({
        status: 401,
      });
    } finally {
      vi.unstubAllGlobals();
    }

    await waitFor(() =>
      expect(window.location.replace).toHaveBeenCalledWith(
        "/login?next=" + encodeURIComponent("/chat?x=1"),
      ),
    );
    expect(await readLocalIdentity()).toBeUndefined();
    expect(sessionStorage.getItem("csrf")).toBeNull();
  });
});

describe("没有本地身份", () => {
  it("取到就进入，并把身份记下来供下次离线打开", async () => {
    answerMe(resolves(ME));

    renderApp();

    expect(await screen.findByText("page body")).toBeTruthy();
    await waitFor(async () => expect(await readLocalIdentity()).toEqual(ME));
  });

  /** 真时钟下走到「第一次核对在飞」，换假时钟后让它失败。 */
  async function renderUnreachable(...later: Array<() => Promise<unknown>>) {
    const first = deferred<Me>();
    answerMe(() => first.promise, ...later);
    renderApp();
    await waitFor(() => expect(meCalls()).toBe(1));
    fakeClock();
    first.reject(new TypeError("Failed to fetch"));
    await advance(0);
  }

  it("取不到：整屏「连不上服务器」，自动重试计第 N 次，「立即重试」取到即进入", async () => {
    await renderUnreachable(
      rejects(new TypeError("Failed to fetch")),
      resolves(ME),
    );

    expect(screen.getByText("Can't reach the server")).toBeTruthy();
    expect(screen.getByText("Retrying automatically · attempt 1")).toBeTruthy();
    expect(screen.queryByText("page body")).toBeNull();
    expect(window.location.replace).not.toHaveBeenCalled();

    await advance(1_000);
    expect(meCalls()).toBe(2);
    expect(screen.getByText("Retrying automatically · attempt 2")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    await advance(0);

    expect(screen.getByText("page body")).toBeTruthy();
    expect(meCalls()).toBe(3);
  });

  it("「立即重试」在一次核对在飞时禁用自己", async () => {
    const second = deferred<Me>();
    await renderUnreachable(() => second.promise);

    const button = screen.getByRole("button", { name: "Retry now" });
    fireEvent.click(button);
    await advance(0);
    expect(meCalls()).toBe(2);
    expect(
      (screen.getByRole("button", { name: "Retry now" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    second.resolve(ME);
    await advance(0);
    expect(screen.getByText("page body")).toBeTruthy();
  });

  it.each([
    ["联网", () => window.dispatchEvent(new Event("online"))],
    [
      "回到前台",
      () => {
        Object.defineProperty(document, "visibilityState", {
          value: "visible",
          configurable: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      },
    ],
  ])("%s时立即重试，不等退避", async (_name, trigger) => {
    await renderUnreachable(resolves(ME));
    expect(screen.getByText("Can't reach the server")).toBeTruthy();

    act(trigger);
    await advance(0);

    expect(screen.getByText("page body")).toBeTruthy();
    expect(meCalls()).toBe(2);
  });

  it("取到 401 才去登录页", async () => {
    answerMe(rejects(new ApiError(30004, "unauthorized", 401)));

    renderApp();

    await waitFor(() =>
      expect(window.location.replace).toHaveBeenCalledWith(
        "/login?next=" + encodeURIComponent("/chat?x=1"),
      ),
    );
    expect(screen.queryByText("Can't reach the server")).toBeNull();
  });

  it("本地存储不可用：退回每次联网，等 /auth/me 回来才进入", async () => {
    delete g.indexedDB;
    let release!: (me: Me) => void;
    answerMe(() => new Promise<Me>((r) => (release = r)));

    renderApp();

    await waitFor(() => expect(meCalls()).toBe(1));
    expect(screen.queryByText("page body")).toBeNull();
    act(() => release(ME));
    expect(await screen.findByText("page body")).toBeTruthy();
  });
});

describe("身份全局只取一次", () => {
  function Probe({ name }: { name: string }) {
    const { me } = useMe();
    return <span>{`${name}:${me?.email ?? "-"}`}</span>;
  }

  it("多处使用、换页重挂都共用同一次结果", async () => {
    answerMe(resolves(ME));

    const first = renderApp();
    await screen.findByText("page body");
    first.unmount();

    render(
      <MemoryRouter>
        <ThemeProvider>
          <RequireAuth>
            <Probe name="a" />
            <Probe name="b" />
          </RequireAuth>
        </ThemeProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText(`a:${ME.email}`)).toBeTruthy();
    expect(screen.getByText(`b:${ME.email}`)).toBeTruthy();
    expect(meCalls()).toBe(1);
  });
});

describe("登出", () => {
  it("登出请求带着 CSRF 发出去，随后清空本地，再落地登录页", async () => {
    await seedLocal(ME);
    sessionStorage.setItem("csrf", ME.csrf_token);
    let csrfAtLogout: string | null = null;
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/logout") {
        csrfAtLogout = sessionStorage.getItem("csrf");
        return {};
      }
      throw new ApiError(30001, "not under test", 500);
    });
    let identityAtLanding: unknown = "not landed";
    vi.mocked(window.location.assign).mockImplementation(() => {
      void readLocalIdentity().then((v) => {
        identityAtLanding = v;
      });
    });

    signOut();

    await waitFor(() =>
      expect(window.location.assign).toHaveBeenCalledWith("/login"),
    );
    expect(csrfAtLogout).toBe(ME.csrf_token);
    await waitFor(() => expect(identityAtLanding).toBeUndefined());
    bindAccount(ME.user_id);
    expect(await accountStore.get("list", "all")).toBeUndefined();
    bindAccount(null);
    expect(sessionStorage.getItem("csrf")).toBeNull();
  });
});
