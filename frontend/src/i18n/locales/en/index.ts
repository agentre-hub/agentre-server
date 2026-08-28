import account from "./account.json";
import appShell from "./appShell.json";
import authLayout from "./authLayout.json";
import chat from "./chat.json";
import common from "./common.json";
import composer from "./composer.json";
import console from "./console.json";
import device from "./device.json";
import issues from "./issues.json";
import legal from "./legal.json";
import login from "./login.json";
import nav from "./nav.json";
import notFound from "./notFound.json";
import org from "./org.json";
import overview from "./overview.json";
import project from "./project.json";
import session from "./session.json";
import sessionIndex from "./sessionIndex.json";
import settings from "./settings.json";
import slashCommands from "./slashCommands.json";

/**
 * en 语言包：按模块拆成同目录下的 `<module>.json`，在这里合成一份交给 i18next。
 *
 * 约定 **文件名即顶层 key**（`appShell.json` → `t("appShell.…")`），新增模块时
 * 加一个 json 再在这里 import 一行即可；漏 import 或挂错 key 由
 * `__tests__/locale-modules.test.ts` 拦住。en 是键集合的基准语言。
 */
export default {
  account,
  appShell,
  authLayout,
  chat,
  common,
  composer,
  console,
  device,
  issues,
  legal,
  login,
  nav,
  notFound,
  org,
  overview,
  project,
  session,
  sessionIndex,
  settings,
  slashCommands,
};
