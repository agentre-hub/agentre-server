/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://console.example.test/devices" }
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  BrowserRouter,
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AddDeviceGuide } from "@/components/AddDeviceGuide";
import i18n from "@/i18n";
import { ApiError, api } from "@/lib/api";
import { DEVICE_FLOW_CODES } from "@/lib/errorCodes";
import { ThemeProvider } from "@/lib/theme";
import Device from "@/pages/Device";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

/** 提交后跳到哪里：用真的 router 位置作答，不去 mock useNavigate。 */
function LocationProbe() {
  const loc = useLocation();
  return <span data-testid="location">{`${loc.pathname}${loc.search}`}</span>;
}

/**
 * 页内三步引导的内容契约（规格「web 控制台：设备页 · 三步 / 第 1 步 · 装 /
 * 第 2 步 · 登录 / 第 3 步 · 输码」）。
 *
 * 这个文件的 jsdom URL 被换成了一个虚构域名：登录命令里的服务器地址必须是
 * **当前控制台自己的地址**，写死任何域名（包括 mockup 里的 hub.agentre.ai）
 * 都会在这里红掉。
 */
function renderGuide() {
  return render(
    <MemoryRouter initialEntries={["/devices"]}>
      <AddDeviceGuide />
      <LocationProbe />
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
}

/** 六格码格（引导第 3 步与既有输码屏共用同一个组件，所以定位方式也一样）。 */
function boxes(): HTMLInputElement[] {
  return within(
    screen.getByRole("group", { name: "Device code" }),
  ).getAllByRole("textbox") as HTMLInputElement[];
}

function typeCode(text: string) {
  text.split("").forEach((ch, i) => {
    const box = boxes()[i];
    box.focus();
    fireEvent.change(box, { target: { value: ch } });
  });
}

function values() {
  return boxes().map((b) => b.value);
}

function openCodeStep() {
  fireEvent.click(screen.getByTestId("add-device-step-3"));
}

function submitCode() {
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

const INSTALL_UNIX =
  "curl -fsSL https://github.com/agentre-ai/agentre/releases/latest/download/install.sh | sh";
const INSTALL_WIN =
  "irm https://github.com/agentre-ai/agentre/releases/latest/download/install.ps1 | iex";

beforeEach(async () => {
  await i18n.changeLanguage("en");
  // 下面有一条用真 BrowserRouter 走完整跳转的用例，它会改掉 jsdom 的地址；
  // 每个用例都从设备页重新开始，免得互相污染。
  window.history.replaceState({}, "", "/devices");
  mockedApi.mockReset();
  mockedApi.mockRejectedValue(new Error("unexpected call"));
});

describe("add-device guide · steps and commands", () => {
  it("只提供两种设备类型：计算节点与桌面端（浏览器/移动端不是可加的类型）", () => {
    renderGuide();

    expect(
      screen.getByRole("button", { name: "Compute node (agentred)" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Desktop (Agentre App)" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /browser/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /mobile/i })).toBeNull();
  });

  it("第 1 步 · 计算节点：给出所选系统的安装命令与后台服务命令", () => {
    renderGuide();

    expect(screen.getByTestId("add-device-command-install").textContent).toBe(
      INSTALL_UNIX,
    );
    expect(screen.getByTestId("add-device-command-service").textContent).toBe(
      "agentred service install --start",
    );

    fireEvent.click(screen.getByRole("button", { name: "Windows" }));
    expect(screen.getByTestId("add-device-command-install").textContent).toBe(
      INSTALL_WIN,
    );

    fireEvent.click(screen.getByRole("button", { name: "macOS" }));
    expect(screen.getByTestId("add-device-command-install").textContent).toBe(
      INSTALL_UNIX,
    );
  });

  it("第 1 步 · 桌面端：换成下载入口，不再有系统切换与 agentred 安装命令", () => {
    renderGuide();

    fireEvent.click(
      screen.getByRole("button", { name: "Desktop (Agentre App)" }),
    );

    expect(screen.queryByTestId("add-device-command-install")).toBeNull();
    expect(screen.queryByRole("button", { name: "Windows" })).toBeNull();
    const download = screen.getByTestId("add-device-download");
    expect(download.getAttribute("href")).toBe(
      "https://github.com/agentre-ai/agentre/releases/latest",
    );
  });

  it("第 2 步 · 计算节点：登录命令带的是当前控制台地址，不是写死的域名", () => {
    renderGuide();

    fireEvent.click(screen.getByTestId("add-device-step-2"));

    expect(screen.getByTestId("add-device-command-login").textContent).toBe(
      "agentred login --server https://console.example.test",
    );

    const body = screen.getByTestId("add-device-step-body").textContent ?? "";
    // 命令会打印 6 位码、会尝试开浏览器、没浏览器就把码带回来
    expect(body).toMatch(/User code/);
    expect(body).toMatch(/browser/i);
    // 有效期可配置：这一屏不许写死任何时长
    expect(body).not.toMatch(/\d+\s*(minutes?|分钟)/);
  });

  it("第 2 步 · 桌面端：同一个控制台地址 + 应用内登录路径", () => {
    renderGuide();

    fireEvent.click(
      screen.getByRole("button", { name: "Desktop (Agentre App)" }),
    );
    fireEvent.click(screen.getByTestId("add-device-step-2"));

    expect(screen.queryByTestId("add-device-command-login")).toBeNull();
    expect(screen.getByTestId("add-device-server-address").textContent).toBe(
      "https://console.example.test",
    );
    const body = screen.getByTestId("add-device-step-body").textContent ?? "";
    expect(body).toMatch(/Settings/);
    expect(body).not.toMatch(/\d+\s*(minutes?|分钟)/);
  });

  it("步骤条三格都可点：跳到第 3 步只换当前步骤，不伪造完成标记", () => {
    renderGuide();

    const step1 = screen.getByTestId("add-device-step-1");
    const step3 = screen.getByTestId("add-device-step-3");
    expect(step1.getAttribute("aria-current")).toBe("step");

    fireEvent.click(step3);

    expect(step3.getAttribute("aria-current")).toBe("step");
    expect(step1.getAttribute("aria-current")).toBeNull();
    // 跳步过去的：第 1/2 步没有点过「下一步」，就不该显示完成
    expect(within(step1).queryByText("Installed")).toBeNull();
    expect(
      within(screen.getByTestId("add-device-step-2")).queryByText("Signed in"),
    ).toBeNull();
  });

  it("点过某一步的「下一步」才出现完成标记，并前进到下一步", () => {
    renderGuide();

    fireEvent.click(screen.getByRole("button", { name: "Installed — next" }));

    const step1 = screen.getByTestId("add-device-step-1");
    const step2 = screen.getByTestId("add-device-step-2");
    expect(within(step1).getByText("Installed")).toBeTruthy();
    expect(step2.getAttribute("aria-current")).toBe("step");
    expect(within(step2).queryByText("Signed in")).toBeNull();
  });

  it("第 3 步用的就是既有的六格设备码输入，校验规则一模一样", () => {
    renderGuide();
    openCodeStep();

    const bs = boxes();
    expect(bs).toHaveLength(6);
    expect(bs[0].getAttribute("aria-label")).toBe("Character 1 of 6");
    // 字母表外的字形（0/O/1/I）进不来——与既有输码屏同一套规则，
    // 说明这里用的是同一个组件而不是第二份码格。
    fireEvent.change(bs[0], { target: { value: "O" } });
    expect(values()[0]).toBe("");
  });

  it("填满六位提交：跳到既有授权确认屏，带上归一化后的设备码", () => {
    renderGuide();
    openCodeStep();

    typeCode("a4f7q2");
    submitCode();

    expect(screen.getByTestId("location").textContent).toBe(
      "/device?user_code=A4F-7Q2",
    );
  });

  it("不足六位：就地报错、不跳转，已填的字符一个都不丢", () => {
    renderGuide();
    openCodeStep();

    typeCode("a4f");
    submitCode();

    expect(screen.getByTestId("location").textContent).toBe("/devices");
    expect(screen.getByText("Enter all six characters.")).toBeTruthy();
    expect(values()).toEqual(["A", "4", "F", "", "", ""]);
    expect(boxes()[0].getAttribute("aria-invalid")).toBe("true");
  });

  it("再动一下输入就撤掉红态", () => {
    renderGuide();
    openCodeStep();

    typeCode("a4f");
    submitCode();
    typeCode("a4f7");

    expect(screen.queryByText("Enter all six characters.")).toBeNull();
    expect(boxes()[0].getAttribute("aria-invalid")).toBeNull();
  });

  it("第 3 步不复制授权确认屏的任何一项（风险说明/代码核对/允许拒绝/倒计时）", () => {
    renderGuide();
    openCodeStep();

    expect(
      screen.queryByRole("button", { name: /allow access|deny/i }),
    ).toBeNull();
    const body = screen.getByTestId("add-device-step-body").textContent ?? "";
    expect(body).not.toMatch(/full access/i); // 风险说明
    expect(body).not.toMatch(/matches exactly/i); // 代码核对
    expect(body).not.toMatch(/expires in/i); // 过期倒计时
  });

  it("复制按钮把命令原样交给剪贴板", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    renderGuide();
    fireEvent.click(screen.getByTestId("add-device-copy-install"));

    expect(writeText).toHaveBeenCalledWith(INSTALL_UNIX);
    expect(await screen.findByText("Copied")).toBeTruthy();
  });
});

/**
 * 第 3 步只负责把设备码交出去；「这个代码存不存在」由既有的授权确认屏回答
 * （规格「不新增第二份批准界面」）。这条用例走真 router 的整段交接，证明
 * 交出去的形态那一屏收得下：代码不存在时它沿用既有文案就地标红，
 * 六格里的字符一个不丢。
 */
describe("add-device guide · 第 3 步交接给既有授权确认屏", () => {
  it("代码不存在或已被使用：就地标红且保留已填字符", async () => {
    mockedApi.mockRejectedValue(
      new ApiError(
        DEVICE_FLOW_CODES.DeviceFlowUserCodeInvalid,
        "user_code invalid",
        400,
      ),
    );

    render(
      <BrowserRouter>
        <Routes>
          <Route path="/devices" element={<AddDeviceGuide />} />
          <Route path="/device" element={<Device />} />
        </Routes>
      </BrowserRouter>,
      { wrapper: ThemeProvider },
    );

    openCodeStep();
    typeCode("a4f7q2");
    submitCode();

    expect(await screen.findByText(/already been used/i)).toBeTruthy();
    expect(values()).toEqual(["A", "4", "F", "7", "Q", "2"]);
    const lookups = mockedApi.mock.calls.filter(([path]) =>
      path.startsWith("/v1/oauth/device/pending"),
    );
    expect(lookups).toHaveLength(1);
    expect(lookups[0][0]).toContain("user_code=A4F-7Q2");
  });
});
