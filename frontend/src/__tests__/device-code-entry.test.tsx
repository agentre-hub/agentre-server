import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, api } from "@/lib/api";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import i18n from "@/i18n";
import Device from "@/pages/Device";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

function renderEntry() {
  return render(
    <MemoryRouter>
      <Device />
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
}

function boxes(): HTMLInputElement[] {
  return screen.getAllByRole("textbox") as HTMLInputElement[];
}

function typeInto(box: HTMLInputElement, value: string) {
  box.focus();
  fireEvent.change(box, { target: { value } });
}

function values() {
  return boxes().map((b) => b.value);
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: /continue|继续/i }));
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.history.replaceState({}, "", "/device");
  mockedApi.mockReset();
  mockedApi.mockRejectedValue(new Error("unexpected call"));
});

describe("设备码输入：六个真实码格", () => {
  it("渲染六个输入框，各自带位次 aria-label", () => {
    renderEntry();
    const bs = boxes();
    expect(bs).toHaveLength(6);
    bs.forEach((b, i) => {
      expect(b.getAttribute("aria-label")).toContain(String(i + 1));
    });
  });

  it("逐格输入会大写并自动前进到下一格", () => {
    renderEntry();
    typeInto(boxes()[0], "a");
    expect(values()[0]).toBe("A");
    expect(document.activeElement).toBe(boxes()[1]);
  });

  it("字母表外的字符（0/O/1/I）进不来，也不前进", () => {
    renderEntry();
    typeInto(boxes()[0], "O");
    expect(values()[0]).toBe("");
    expect(document.activeElement).toBe(boxes()[0]);
  });

  it("在空格上退格会回到上一格并清掉它", () => {
    renderEntry();
    typeInto(boxes()[0], "A");
    // 焦点此刻在第二格（空），退格应回到第一格并清空
    fireEvent.keyDown(boxes()[1], { key: "Backspace" });
    expect(values()[0]).toBe("");
    expect(document.activeElement).toBe(boxes()[0]);
  });

  it("在有字符的格上退格只清掉本格，不回退", () => {
    renderEntry();
    typeInto(boxes()[0], "A");
    // 用户点回第一格再退格
    boxes()[0].focus();
    fireEvent.keyDown(boxes()[0], { key: "Backspace" });
    expect(values()[0]).toBe("");
    expect(document.activeElement).toBe(boxes()[0]);
  });

  it("粘贴整串（带连字符、小写）一次填满六格", () => {
    renderEntry();
    fireEvent.paste(boxes()[0], {
      clipboardData: { getData: () => "a4f-7q2" },
    });
    expect(values()).toEqual(["A", "4", "F", "7", "Q", "2"]);
  });

  it("粘贴不带连字符的整串同样填满六格", () => {
    renderEntry();
    fireEvent.paste(boxes()[0], {
      clipboardData: { getData: () => "A4F7Q2" },
    });
    expect(values()).toEqual(["A", "4", "F", "7", "Q", "2"]);
  });
});

describe("设备码输入：提交", () => {
  it("填满六格后提交，按归一化后的代码查 pending", async () => {
    mockedApi.mockResolvedValue({
      device_kind: "desktop",
      platform: "darwin",
      version: "0.3.0",
      expires_in: 600,
    });
    renderEntry();
    fireEvent.paste(boxes()[0], {
      clipboardData: { getData: () => "a4f7q2" },
    });
    submit();

    // 查到 pending 后进确认屏——那是同一路由下的整页区域（决策 8），
    // 这里只保证入口屏把它交出去了，确认屏本身由 device-approval-risk 覆盖
    await screen.findByRole("heading", {
      level: 1,
      name: /allow this device/i,
    });
    // 只数查 pending 那一次：确认屏还会为账户头像拉一次 /v1/auth/me，
    // 那是另一件事，不该让这条断言随它变。
    const lookups = mockedApi.mock.calls.filter(([path]) =>
      path.startsWith("/v1/oauth/device/pending"),
    );
    expect(lookups).toHaveLength(1);
    expect(lookups[0][0]).toContain("user_code=A4F-7Q2");
  });

  it("不满六位时提交：不发请求，就地报错", async () => {
    renderEntry();
    typeInto(boxes()[0], "A");
    typeInto(boxes()[1], "4");
    submit();

    expect(mockedApi).not.toHaveBeenCalled();
    expect(await screen.findByText(/enter all six characters/i)).toBeTruthy();
    expect(boxes()[0].getAttribute("aria-invalid")).toBe("true");
  });
});

describe("设备码输入：代码不存在或已使用（30205）", () => {
  async function submitInvalidCode() {
    mockedApi.mockRejectedValue(new ApiError(30205, "user_code invalid", 400));
    renderEntry();
    fireEvent.paste(boxes()[0], {
      clipboardData: { getData: () => "A4F7Q2" },
    });
    submit();
    return await screen.findByText(/already been used/i);
  }

  it("停在输入屏，不跳页，已输入的字符保留", async () => {
    await submitInvalidCode();
    expect(
      screen.getByRole("heading", { level: 1, name: /enter the device code/i }),
    ).toBeTruthy();
    expect(values()).toEqual(["A", "4", "F", "7", "Q", "2"]);
  });

  it("六个码格都带上 aria-invalid", async () => {
    await submitInvalidCode();
    boxes().forEach((b) => expect(b.getAttribute("aria-invalid")).toBe("true"));
  });

  it("错误文案经 aria-describedby 关联到码格组", async () => {
    const error = await submitInvalidCode();
    const ids = (
      screen.getByRole("group").getAttribute("aria-describedby") ?? ""
    ).split(/\s+/);
    expect(ids).toContain(error.id);
    expect(error.id).toBeTruthy();
  });

  it("其余失败（非 30205）仍以 Alert 呈现，不当成代码错误", async () => {
    mockedApi.mockRejectedValue(new ApiError(30001, "boom", 500));
    renderEntry();
    fireEvent.paste(boxes()[0], {
      clipboardData: { getData: () => "A4F7Q2" },
    });
    submit();

    expect((await screen.findByRole("alert")).textContent).toContain("boom");
    expect(screen.queryByText(/already been used/i)).toBeNull();
  });
});

describe("设备码输入：中文文案照画板", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("标题与脚注用画板上的中文", () => {
    renderEntry();
    expect(
      screen.getByRole("heading", { level: 1, name: "输入设备码" }),
    ).toBeTruthy();
    expect(
      screen.getByText("没有看到代码？回到设备上重新发起授权。"),
    ).toBeTruthy();
  });

  it("30205 的中文错误文案照画板 18", async () => {
    mockedApi.mockRejectedValue(new ApiError(30205, "user_code invalid", 400));
    renderEntry();
    fireEvent.paste(boxes()[0], {
      clipboardData: { getData: () => "A4F7Q2" },
    });
    submit();

    expect(
      await screen.findByText(
        "这个代码不存在或已被使用。请核对设备上显示的 6 位代码。",
      ),
    ).toBeTruthy();
  });
});
