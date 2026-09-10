import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SignalChannelID } from "@/lib/relayConnection";
import {
  ConversationTargetPrefix,
  MachineTargetPrefix,
} from "@/lib/relayTarget";

/**
 * 通道寻址的字符串契约守卫（决策 10 / 11 / 14）。
 *
 * 目标前缀与保留通道号是**两端各写一份**的裸字符串：服务端在
 * `relay_svc/target.go` 里解析它们，浏览器在 `relayTarget` / `relayConnection` 里
 * 生成它们。改一边忘另一边不会报任何错——通道会被当成「目标不成形」判死，或者
 * 账号信号落在一个谁都不认的通道号上、页面无声地退回 30 秒轮询。
 *
 * 手法与 error-code-contract / design-token-contract 相同：直接读那份权威源文件，
 * 把常量原样比出来。
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const TARGET_GO = path.join(REPO_ROOT, "internal/service/relay_svc/target.go");

const go = fs.readFileSync(TARGET_GO, "utf8");

/** 取一个 Go 字符串常量的字面量值。 */
function goConst(name: string): string {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(go);
  expect(match, `relay_svc 里找不到常量 ${name}`).toBeTruthy();
  return match![1];
}

describe("通道目标与保留通道号的两端契约", () => {
  it("两种目标前缀与服务端逐字相同", () => {
    expect(ConversationTargetPrefix).toBe(goConst("TargetPrefixConversation"));
    expect(MachineTargetPrefix).toBe(goConst("TargetPrefixMachine"));
  });

  /**
   * 保留号在 Go 那边是 `ReservedChannelPrefix + "signal"` 拼出来的，所以这里也拼
   * 一次再比——直接找一个字面量会漏掉「前缀改了、后缀没改」这一半。
   */
  it("账号信号那条保留通道号与服务端逐字相同", () => {
    const prefix = goConst("ReservedChannelPrefix");
    const suffix =
      /SignalChannelID\s*=\s*ReservedChannelPrefix\s*\+\s*"([^"]*)"/.exec(
        go,
      )?.[1];
    expect(suffix, "relay_svc 里找不到 SignalChannelID 的拼法").toBeTruthy();
    expect(SignalChannelID).toBe(`${prefix}${suffix}`);
  });

  /**
   * 客户端自选的通道号**不许**落进保留段：那一段归服务端（决策 14）。号由
   * `RelayConnection` 生成，字母表是 `c<自增数>`，与 `~` 不相交。
   */
  it("保留前缀不在客户端自选通道号的字母表里", () => {
    const prefix = goConst("ReservedChannelPrefix");
    for (let i = 1; i <= 100; i++) {
      expect(`c${i}`.startsWith(prefix)).toBe(false);
    }
  });
});
