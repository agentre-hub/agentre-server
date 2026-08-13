/** task 3 的 runner 把正式 server 绑定到专用 loopback 端口，并通过环境交给浏览器。 */
export const APP_BASE_URL = process.env.E2E_BASE_URL;

if (!APP_BASE_URL) {
  throw new Error(
    "E2E_BASE_URL is required. Run the browser suite through `make e2e` or `pnpm smoke`.",
  );
}
