/**
 * DUAL-END e2e 的共用接缝:`node run-e2e-web.mjs --dual` 播种什么,这里就读什么。
 *
 * 浏览器那一侧的登录 / 指纹装配沿用 web/harness.ts 的 fixture(同一个一次性账号、
 * 同一份 cookie 约定);这里只补桌面端那一侧:它的地址、它的设备指纹,以及两个
 * **独立于任何应用服务层**的 SQLite oracle(桌面端 agentre.db 与 agentred.db)。
 */
import { DatabaseSync } from "node:sqlite";

import { agentredDB, requiredEnv } from "../web/harness";

export { test, agentredDB, agentredFP, serverURL } from "../web/harness";

/** 真 Wails 桌面端的 IPC 桥地址(端口由 runner 定,见 DESKTOP_DEVSERVER)。 */
export const desktopURL = requiredEnv("WEBE2E_DESKTOP_URL");
/** 桌面端的 SQLite —— 转录落库的权威来源。 */
export const desktopDB = requiredEnv("WEBE2E_DESKTOP_DB");
/** 桌面端的设备指纹 = 它在 agentred 上的对端身份(会话归属的前半段)。 */
export const desktopFP = requiredEnv("WEBE2E_DESKTOP_FINGERPRINT");

/** 只读打开一个 SQLite,查完就关(两个库都在被活着的进程写,故设 busy_timeout)。 */
function read<T>(path: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

export interface DesktopSessionRow {
  id: number;
  title: string;
  exec_device_id: number;
  agent_id: number;
}

/** 桌面端上标题为 title 的会话(没有则 null)。会话 id 同时是它在 agentred 上的 peer_session_id。 */
export function desktopSessionByTitle(title: string): DesktopSessionRow | null {
  return read(desktopDB, (db) => {
    const row = db
      .prepare(
        `SELECT id, title, exec_device_id, agent_id FROM chat_sessions WHERE title = ?`,
      )
      .get(title) as DesktopSessionRow | undefined;
    return row ?? null;
  });
}

/** 桌面端上某个 Agent 的账号级同步标识(块 1 的 ULID)。 */
export function desktopAgentSyncID(agentID: number): string {
  return read(desktopDB, (db) => {
    const row = db
      .prepare(`SELECT sync_id FROM agents WHERE id = ?`)
      .get(agentID) as { sync_id: string } | undefined;
    return row?.sync_id ?? "";
  });
}

export interface DesktopMessageRow {
  seq: number;
  role: string;
  blocks_json: string;
}

/** 桌面端某条会话的转录(按 seq 升序),包含每一行的角色与正文。 */
export function desktopTranscript(sessionID: number): DesktopMessageRow[] {
  return read(
    desktopDB,
    (db) =>
      db
        .prepare(
          `SELECT seq, role, blocks_json FROM chat_messages WHERE session_id = ? ORDER BY seq`,
        )
        .all(sessionID) as unknown as DesktopMessageRow[],
  );
}

export interface AgentredSessionRow {
  title: string;
  agent_sync_id: string;
  provider_session_id: string;
  backend_type: string;
}

/**
 * agentred 的通知日志里,这条会话有没有一帧的载荷含 needle。
 * daemon 的 daemon_notification_logs 是「这台机器上真的发生过什么」的权威来源,
 * 不经任何一个端 —— 用来给「另一个端确实答过了」这类前提留一份独立证据。
 */
export function agentredJournalHas(
  peerFingerprint: string,
  peerSessionID: number,
  needle: string,
): boolean {
  return read(agentredDB, (db) => {
    const row = db
      .prepare(
        `SELECT count(*) AS n FROM daemon_notification_logs
          WHERE peer_fingerprint = ? AND peer_session_id = ? AND payload LIKE '%' || ? || '%'`,
      )
      .get(peerFingerprint, String(peerSessionID), needle) as { n: number };
    return row.n > 0;
  });
}

/** agentred 上属于某个对端的某条会话行(没有则 null)——R7 落库与否的权威来源。 */
export function agentredSession(
  peerFingerprint: string,
  peerSessionID: number,
): AgentredSessionRow | null {
  return read(agentredDB, (db) => {
    const row = db
      .prepare(
        `SELECT title, agent_sync_id, provider_session_id, backend_type
           FROM daemon_sessions WHERE peer_fingerprint = ? AND peer_session_id = ?`,
      )
      .get(peerFingerprint, String(peerSessionID)) as
      AgentredSessionRow | undefined;
    return row ?? null;
  });
}
