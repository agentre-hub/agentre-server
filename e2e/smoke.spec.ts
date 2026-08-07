import {
  assertIsAppUnderTest,
  expect,
  mockAuthenticated,
  mockDevicePending,
  mockUnauthenticated,
  test,
} from "./fixtures/app";

/**
 * 冒烟轨道：只放「坏了就等于整个应用不能用」的核心链路。
 * 进这个文件的门槛很高——拿不准就写进 scratch/，见 README.md。
 */

test("应用能起来，且连上的确实是被测应用", async ({ page }) => {
  await mockUnauthenticated(page);
  await page.goto("/login");
  await assertIsAppUnderTest(page);
});

test("未登录访问 /device 会跳到 /login", async ({ page }) => {
  await mockUnauthenticated(page);
  // waitUntil:'commit' —— RequireAuth 会在渲染中调 location.replace，
  // 把 /device 这次导航打断；等 'load' 的话 goto/waitForURL 会收到
  // net::ERR_ABORTED，测的是竞态而不是行为。
  await page.goto("/device", { waitUntil: "commit" });
  await expect(page.getByRole("button", { name: /GitHub/i })).toBeVisible();
  expect(page.url()).toContain("/login");
});

test("未知路由渲染 404 而不是白屏", async ({ page }) => {
  await page.goto("/no-such-page");
  // "404" 现在是 aria-hidden 的水印，真正的 h1 是可翻译的标题文案
  await expect(
    page.getByRole("heading", { name: /页面不存在|Page not found/i }),
  ).toBeVisible();
  // AuthLayout 现在还带页脚链接（Terms/Privacy/Status），不能再用不带
  // name 的 getByRole("link")——那会撞上 strict mode。只认返回首页那个。
  await expect(
    page.getByRole("link", { name: /回到首页|Back to home/i }),
  ).toBeVisible();
});

test("设备授权页能查到 pending 设备并就地渲染确认区", async ({ page }) => {
  await mockAuthenticated(page);
  await mockDevicePending(page);

  await page.goto("/device?user_code=A4F-7Q2");

  // 确认区是 /device 下的整页区域而不是对话框（决策 8）
  const main = page.getByRole("main");
  await expect(main).toContainText("A4F-7Q2");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // 只断言真实设备信息被列出来，不断言具体文案——文案是可翻译的。
  // chat 不在收录表里，按原样透出（决策 12）。
  await expect(main).toContainText("chat");
  await expect(main).toContainText("darwin");
});

test("主题切换会把 dark class 挂到 <html> 上并持久化", async ({ page }) => {
  await mockUnauthenticated(page);
  await page.goto("/login");

  const html = page.locator("html");
  const themeButton = page.getByRole("button", { name: /Theme|主题/i });

  // system → light → dark，点到 dark 为止
  for (let i = 0; i < 3; i++) {
    if (await html.evaluate((el) => el.classList.contains("dark"))) break;
    await themeButton.click();
  }
  await expect(html).toHaveClass(/dark/);

  // 刷新后仍然是 dark —— 证明写进了 localStorage 而不只是内存状态
  await page.reload();
  await expect(html).toHaveClass(/dark/);
});

test("语言切换会改变界面文案和 <html lang>", async ({ page }) => {
  await mockUnauthenticated(page);
  await page.goto("/login?lang=en");

  await expect(
    page.getByRole("button", { name: "Sign in with GitHub" }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  await page.getByRole("button", { name: /Language|语言/i }).click();

  await expect(
    page.getByRole("button", { name: "使用 GitHub 登录" }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
});

test("认证流在当前视口下不横向溢出", async ({ page }) => {
  // 移动端 project 下这条才有意义：卡片贴边 / 溢出会在这里被抓到
  const overflow = () =>
    page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );

  await mockUnauthenticated(page);
  await page.goto("/login");
  await assertIsAppUnderTest(page);
  expect(await overflow()).toBeLessThanOrEqual(0);

  // 六个码格是这条流里最宽的一排硬约束：画板画的是 6×54 加间距和分隔线，
  // 手机宽度扣掉外壳与卡片的内边距后所剩无几。这排要是不肯缩（改了
  // max-w / gap / flex，或给行加了固定宽度），只有真排版量得出来——
  // jsdom 不算布局，单测在这件事上一个字都测不到。
  await mockAuthenticated(page);
  await page.goto("/device");
  await expect(page.getByRole("group")).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
});
