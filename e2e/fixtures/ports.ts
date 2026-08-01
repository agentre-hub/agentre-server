/**
 * e2e 专用端口。
 *
 * 刻意避开开发端口（vite 5174 / server 8443）：如果 e2e 连的是你正在手动调试的
 * 那个实例，它可能跑的是别的分支、带着脏数据，测试结果就没有意义了。
 * 专用端口 + 启动断言（见 fixtures/app.ts 的 assertIsAppUnderTest）
 * 才能保证「连上的确实是这次要测的东西」。
 */
export const APP_PORT = Number(process.env.E2E_PORT ?? 5199);
/** 显式绑到 127.0.0.1：不指定时 vite 只监听 localhost，而在 macOS 上
 *  localhost 可能先解析到 ::1，导致对 127.0.0.1 的健康检查一直超时。 */
export const APP_HOST = "127.0.0.1";
export const APP_BASE_URL = `http://${APP_HOST}:${APP_PORT}`;

/** 起前端 dev server 的命令，两份 playwright 配置共用。 */
export const FRONTEND_DEV_COMMAND = `pnpm --dir ../frontend dev --port ${APP_PORT} --strictPort --host ${APP_HOST}`;

/** 后端 mock 的端口，scratch 轨道需要真后端时用。 */
export const MOCK_API_PORT = Number(process.env.E2E_MOCK_API_PORT ?? 8199);
