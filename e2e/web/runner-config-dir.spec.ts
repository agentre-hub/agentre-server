/**
 * runner 从哪儿取 configs/config.yaml。
 *
 * 守的是一处真实的死路:本仓的 `configs/config.yaml` 可以是 `source: etcd` ——
 * 那时整份配置(含 http.address、db、redis、jwt 路径)都由 etcd 给,cago 会把
 * 本地文件整个换掉(cago configs/config.go 的 init:source 非 file 时替换 source)。
 * 于是 runner 既读不到 db.dsn 去播种,它起的 server 也会照 etcd 去绑 0.0.0.0:8443,
 * 把「跑在一个空闲端口上」这条隔离直接作废。
 *
 * 出口是让开发者显式指一份**本机可用**的配置,而不是让 runner 去猜或去改写 etcd。
 */
import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configCheckoutFor } from "../run-e2e-web.mjs";

function checkoutWithConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "webe2e-cfgdir-"));
  mkdirSync(join(dir, "configs"), { recursive: true });
  writeFileSync(join(dir, "configs", "config.yaml"), 'db:\n  dsn: "x"\n');
  return dir;
}

test("默认用本检出自己的 configs/config.yaml", () => {
  const checkout = checkoutWithConfig();
  expect(configCheckoutFor(checkout, {})).toBe(checkout);
});

test("WEBE2E_CONFIG_DIR 指到哪就用哪 —— etcd 档下的唯一出口", () => {
  const checkout = checkoutWithConfig();
  const override = checkoutWithConfig();
  expect(configCheckoutFor(checkout, { WEBE2E_CONFIG_DIR: override })).toBe(
    override,
  );
});

test("指了一个没有 configs/config.yaml 的目录时当场失败,并说清期望的形状", () => {
  const checkout = checkoutWithConfig();
  const empty = mkdtempSync(join(tmpdir(), "webe2e-empty-"));
  expect(() =>
    configCheckoutFor(checkout, { WEBE2E_CONFIG_DIR: empty }),
  ).toThrow(/configs\/config\.yaml/);
});
