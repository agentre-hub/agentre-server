/**
 * 读懂 daemon 那句协议版本拒绝（`wireversion.Reject`），把它变成人话。
 *
 * 那句话是 Go 侧 `fmt.Sprintf` 出来的英文，此前原样贴在横幅正文里：一个中文界面上
 * 突然出现半句英文源码日志，而它真正携带的信息只有两个版本号。这里把它解析成
 * 「谁旧了」，横幅据此说中文，也据此决定还给不给出口。
 */
import { describe, expect, it } from "vitest";

import {
  EXPECTED_REJECTION,
  readProtocolRejection,
} from "@/lib/protocolMismatch";

/**
 * Go 侧用 `%q` 打两个版本号，所以真正到达浏览器的那句话里**版本号都带引号**。
 * 这里逐字照抄线上样子——用一个仿制品去测，等于测了一个不存在的输入。
 *
 * 判据是精确相等，句子里一边一个版本号（没有窗口）：谁小谁旧，方向就这么来的。
 */
const MACHINE_NEWER =
  'peer speaks wire protocol version "0.3.0", this build speaks "0.4.0"; both ends must run the same release';
const MACHINE_OLDER =
  'peer speaks wire protocol version "0.5.0", this build speaks "0.4.0"; both ends must run the same release';

describe("读 daemon 的协议版本拒绝", () => {
  /**
   * 这条守卫盯的是本解析器唯一的失手方式：认不出就返回 null，而 null 是一条合法路径
   * （横幅退回原话），所以文案一漂，全部用例照样绿。`EXPECTED_REJECTION` 把「本 build
   * 预期收到的那句话」和读它的正则放进同一个文件，这里断言那一句解析得出结果——句式与
   * 正则从此只能一起改，不能一边悄悄错开。
   */
  it("本 build 预期的那种句子必须解析得出结果,不能静默退回 null", () => {
    expect(readProtocolRejection(EXPECTED_REJECTION.detail)).toEqual({
      stale: "page",
      page: EXPECTED_REJECTION.page,
      machine: EXPECTED_REJECTION.machine,
    });
  });

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

  it("上一代那句话（带版本窗口）也认不出:它说的判据已经不存在了", () => {
    // 0.2.0 那一代是区间协商，句式带「accepts protocol versions X to Y」。钉一条
    // 死掉的句式在这里，是为了说明退回原话不是理论上的路径：真有构建这么说话。
    expect(
      readProtocolRejection(
        'peer speaks protocol version "0.3.0", this build accepts protocol versions 0.4.0 to 0.4.0',
      ),
    ).toBeNull();
  });

  it("引号可有可无:同一句话两种写法都读得懂", () => {
    expect(
      readProtocolRejection(
        "peer speaks wire protocol version 0.3.0, this build speaks 0.4.0; both ends must run the same release",
      ),
    ).toEqual({ stale: "page", page: "0.3.0", machine: "0.4.0" });
  });

  it("两个版本号相等时不下判断:那句话没说出谁旧", () => {
    // 相等本来就不会被拒（判据是精确相等），所以这是一句自相矛盾的话。
    // 两个数字之间看不出方向，不能猜一个说法给用户。
    expect(
      readProtocolRejection(
        'peer speaks wire protocol version "0.4.0", this build speaks "0.4.0"; both ends must run the same release',
      ),
    ).toBeNull();
  });
});
