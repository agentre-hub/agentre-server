/**
 * 读懂 daemon 那句协议版本拒绝（`wireversion.Reject`），把它变成人话。
 *
 * 那句话是 Go 侧 `fmt.Sprintf` 出来的英文，此前原样贴在横幅正文里：一个中文界面上
 * 突然出现半句英文源码日志，而它真正携带的信息只有两个版本号。这里把它解析成
 * 「谁旧了」，横幅据此说中文，也据此决定还给不给出口。
 */
import { describe, expect, it } from "vitest";

import { readProtocolRejection } from "@/lib/protocolMismatch";

/**
 * Go 侧用 `%q` 打印对端版本，所以真正到达浏览器的那句话里**版本号带引号**。
 * 这里逐字照抄线上样子——用一个不带引号的仿制品去测，等于测了一个不存在的输入。
 */
const MACHINE_NEWER =
  'peer speaks protocol version "0.3.0", this build accepts protocol versions 0.4.0 to 0.4.0';
const MACHINE_OLDER =
  'peer speaks protocol version "0.5.0", this build accepts protocol versions 0.4.0 to 0.4.0';

describe("读 daemon 的协议版本拒绝", () => {
  it("页面比机器旧:该更新的是这个控制台", () => {
    expect(readProtocolRejection(MACHINE_NEWER)).toEqual({
      stale: "page",
      page: "0.3.0",
      machine: "0.4.0",
    });
  });

  it("机器比页面旧:该更新的是那台机器上的 agentred", () => {
    expect(readProtocolRejection(MACHINE_OLDER)).toEqual({
      stale: "machine",
      page: "0.5.0",
      machine: "0.4.0",
    });
  });

  it("认不出的句子不硬编一个版本号出来", () => {
    // 旧构建换过说法、或者这句话哪天又改了——认不出就是认不出，横幅退回原话。
    expect(readProtocolRejection("protocol version mismatch")).toBeNull();
    expect(readProtocolRejection(undefined)).toBeNull();
    expect(readProtocolRejection("")).toBeNull();
  });

  it("引号可有可无:同一句话两种写法都读得懂", () => {
    expect(
      readProtocolRejection(
        "peer speaks protocol version 0.3.0, this build accepts protocol versions 0.4.0 to 0.4.0",
      ),
    ).toEqual({ stale: "page", page: "0.3.0", machine: "0.4.0" });
  });

  it("版本落在机器的窗口里就不下判断:那句话没说出谁旧", () => {
    // windowMatch 的第二个条件也会拒（页面的 min_supported 高过机器的 protocol），
    // 那种情形下两个数字之间看不出方向,不能猜一个说法给用户。
    expect(
      readProtocolRejection(
        'peer speaks protocol version "0.4.0", this build accepts protocol versions 0.3.0 to 0.5.0',
      ),
    ).toBeNull();
  });
});
