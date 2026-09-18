/**
 * 按地址打开一条会话时先认出它在哪台机器上（规格 2026-09-17-chat-session-url
 * 「Resolving the target machine」）：
 *   1. 宿主递了种子（左栏点开的那一行）就直接用，不发请求；
 *   2. 否则按会话号取账号镜像那一行，用它的 device_fingerprint 在设备名单里换设备；
 *   3. 镜像里没有这一行时用 `?device=`；
 *   4. 都没有、或设备不在名单里 → 找不到。
 * 镜像读取失败与「没有这一行」是两件事：前者可重试，不得说成找不到。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ResolvedSessionDetail from "@/components/session/ResolvedSessionDetail";
import i18n from "@/i18n";
import { api, ApiError } from "@/lib/api";
import { ThemeProvider } from "@agentre-hub/agentre-ui";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

vi.mock("@/components/session/SessionDetailView", () => ({
  default: (props: {
    deviceId: number;
    conversationId: string;
    peerFingerprint?: string;
    initialRow?: { conversation_id: string };
    initialTitle?: string;
  }) => (
    <div
      data-testid="session-detail"
      data-device-id={props.deviceId}
      data-session-id={props.conversationId}
      data-peer-fingerprint={props.peerFingerprint ?? ""}
      data-initial-row={props.initialRow?.conversation_id ?? ""}
      data-initial-title={props.initialTitle ?? ""}
    />
  ),
}));

const mockedApi = vi.mocked(api);

const CID = "01a0ae6a-4e9e-7d68-92ee-0ec6937b6db8";

const devices = [
  { id: 1, name: "k3s-master-1", fingerprint: "fp-k3s", online: true },
  { id: 7, name: "laptop", fingerprint: "fp-laptop", online: false },
];

const mirrorRow = {
  conversation_id: CID,
  peer_fingerprint: "fp-browser",
  device_fingerprint: "fp-laptop",
  title: "重构登录页",
};

function mockApi(opts: {
  rows?: unknown[];
  rowsError?: unknown;
  devicesError?: unknown;
}) {
  mockedApi.mockImplementation(async (path: string) => {
    if (path.startsWith("/v1/agent-sessions?conversation_id=")) {
      if (opts.rowsError) throw opts.rowsError;
      return { total: opts.rows?.length ?? 0, items: opts.rows ?? [] };
    }
    if (path === "/v1/devices") {
      if (opts.devicesError) throw opts.devicesError;
      return { devices };
    }
    throw new Error(`unexpected api call: ${path}`);
  });
}

function renderResolved(
  props: Partial<React.ComponentProps<typeof ResolvedSessionDetail>> = {},
) {
  return render(
    <ThemeProvider>
      <MemoryRouter>
        <ResolvedSessionDetail
          conversationId={CID}
          deviceParam={null}
          form="embedded"
          {...props}
        />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
});

describe("ResolvedSessionDetail", () => {
  it("宿主递了种子时直接渲染详情，不发任何请求", () => {
    mockApi({});
    renderResolved({
      seed: { deviceId: 1, peerFingerprint: "fp-seed", row: mirrorRow },
      initialTitle: "种子标题",
    });

    const detail = screen.getByTestId("session-detail");
    expect(detail.dataset.deviceId).toBe("1");
    expect(detail.dataset.sessionId).toBe(CID);
    expect(detail.dataset.peerFingerprint).toBe("fp-seed");
    expect(detail.dataset.initialRow).toBe(CID);
    expect(detail.dataset.initialTitle).toBe("种子标题");
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it("只有会话号时经镜像行的承载设备找到机器，镜像行作为种子交给详情", async () => {
    mockApi({ rows: [mirrorRow] });
    // ?device= 指向另一台：镜像行是承载设备的真源，优先于它。
    renderResolved({ deviceParam: 1 });

    const detail = await screen.findByTestId("session-detail");
    expect(detail.dataset.deviceId).toBe("7");
    expect(detail.dataset.peerFingerprint).toBe("fp-browser");
    expect(detail.dataset.initialRow).toBe(CID);
  });

  it("镜像里没有这一行时用 ?device=", async () => {
    mockApi({ rows: [] });
    renderResolved({ deviceParam: 1 });

    const detail = await screen.findByTestId("session-detail");
    expect(detail.dataset.deviceId).toBe("1");
    expect(detail.dataset.initialRow).toBe("");
  });

  it("镜像没有这一行、也没有 ?device= 时说找不到", async () => {
    mockApi({ rows: [] });
    renderResolved();

    expect(await screen.findByTestId("session-not-found")).toBeTruthy();
    expect(screen.queryByTestId("session-detail")).toBeNull();
  });

  it("?device= 指向的设备不在账号名单里时说找不到", async () => {
    mockApi({ rows: [] });
    renderResolved({ deviceParam: 99 });

    expect(await screen.findByTestId("session-not-found")).toBeTruthy();
    expect(screen.queryByTestId("session-detail")).toBeNull();
  });

  it("镜像行的承载设备不在名单里时说找不到，不改用 ?device=", async () => {
    mockApi({ rows: [{ ...mirrorRow, device_fingerprint: "fp-gone" }] });
    renderResolved({ deviceParam: 1 });

    expect(await screen.findByTestId("session-not-found")).toBeTruthy();
    expect(screen.queryByTestId("session-detail")).toBeNull();
  });

  it("镜像读取失败时给可重试的错误，不说找不到；重试成功后打开详情", async () => {
    mockApi({ rowsError: new ApiError(500, "boom", 500) });
    renderResolved({ deviceParam: 1 });

    const error = await screen.findByTestId("session-resolve-error");
    expect(screen.queryByTestId("session-not-found")).toBeNull();
    expect(screen.queryByTestId("session-detail")).toBeNull();

    mockApi({ rows: [mirrorRow] });
    fireEvent.click(
      error.querySelector("button") ?? screen.getByRole("button"),
    );

    const detail = await screen.findByTestId("session-detail");
    expect(detail.dataset.deviceId).toBe("7");
  });

  it("设备名单读取失败同样是可重试的错误", async () => {
    mockApi({ rows: [mirrorRow], devicesError: new Error("offline") });
    renderResolved();

    expect(await screen.findByTestId("session-resolve-error")).toBeTruthy();
    expect(screen.queryByTestId("session-not-found")).toBeNull();
  });

  it("种子来自宿主手里真实的那一行：不再拿会话号的形状去怀疑它", () => {
    mockApi({});
    renderResolved({ conversationId: "42", seed: { deviceId: 1 } });

    expect(screen.getByTestId("session-detail").dataset.sessionId).toBe("42");
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it("已经认出机器后地址去掉 ?device=：详情留在原地，不回到空白再认一遍", async () => {
    mockApi({ rows: [] });
    const view = renderResolved({ deviceParam: 1 });
    const detail = await screen.findByTestId("session-detail");
    expect(detail.dataset.deviceId).toBe("1");

    mockApi({ rows: [{ ...mirrorRow, device_fingerprint: "fp-k3s" }] });
    view.rerender(
      <ThemeProvider>
        <MemoryRouter>
          <ResolvedSessionDetail
            conversationId={CID}
            deviceParam={null}
            form="embedded"
          />
        </MemoryRouter>
      </ThemeProvider>,
    );

    expect(screen.getByTestId("session-detail")).toBe(detail);
    await waitFor(() =>
      expect(screen.getByTestId("session-detail").dataset.initialRow).toBe(CID),
    );
    expect(screen.getByTestId("session-detail")).toBe(detail);
  });

  it("会话号不是 UUID 时直接说找不到，不发请求", async () => {
    mockApi({ rows: [mirrorRow] });
    renderResolved({ conversationId: "42", deviceParam: 1 });

    expect(await screen.findByTestId("session-not-found")).toBeTruthy();
    await waitFor(() => expect(mockedApi).not.toHaveBeenCalled());
  });
});
