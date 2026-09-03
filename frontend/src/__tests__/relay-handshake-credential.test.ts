import { ProtobufRpcCodec, rpcMethods } from "@agentre-hub/agentre-wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RelayClient } from "@/lib/relayClient";
import type {
  RelayChannelHandle,
  RelayChannelListener,
  RelayState,
} from "@/lib/relayConnection";
import { machineTarget } from "@/lib/relayTarget";

/**
 * 通道握手用的那份凭据（`auth.account`）。
 *
 * 中继票的寿命只有两分钟（server 的 `relayTicketTTL`），而 agentred 验它的过期
 * （±60s，`daemon/auth` 的 VerifyAccountCredential）。**握手不是只做一次**：每次
 * 换 socket 要重做，通道被单独关掉后重开也要重做，同一条连接上后开的每条通道各做
 * 一次。把建通道那一刻的票记在客户端上、以后每次都出示同一张，是这条线上唯一会
 * 随时间腐坏的东西——对着真机复现出来就是「Connecting…/重连中… 永远转下去」，
 * 线上回的那一帧写着 `account credential expired`。
 *
 * 所以凭据在这里是**一个现取的来源**而不是一个值。这一族用例钉的就是这件事，外加
 * 「取不到票 / 被拒之后自己再试」——否则一次失败就把这条通道永久钉死在 reconnecting，
 * 而那个状态对页面的承诺正是「有人正在重试」。
 */

/** 只实现 RelayClient 用得到的那一小块连接能力，并把通道的收件口留在手里。 */
class FakeConnection {
  state: RelayState = "connected";
  listener: RelayChannelListener | null = null;
  sent: Uint8Array[] = [];

  connect(): Promise<void> {
    return Promise.resolve();
  }

  openChannel(
    _target: string,
    listener: RelayChannelListener,
  ): RelayChannelHandle {
    this.listener = listener;
    return {
      send: (frame: Uint8Array) => {
        this.sent.push(frame);
      },
      close: () => {},
    };
  }
}

/** 这条通道上已经发出去的每一次 auth.account 各带了哪张票。 */
function credentialsSent(connection: FakeConnection): string[] {
  const out: string[] = [];
  for (const frame of connection.sent) {
    const decoded = ProtobufRpcCodec.decode(frame);
    if (
      decoded.body.case === "typedMethodRequest" &&
      decoded.body.method === "authAccount"
    ) {
      out.push((decoded.body.value as { credential: string }).credential);
    }
  }
  return out;
}

/** 把还没应答的那一次 auth.account 答成成功。 */
function answerAuth(connection: FakeConnection): void {
  const pending = connection.sent
    .map((frame) => ProtobufRpcCodec.decode(frame))
    .filter(
      (frame) =>
        frame.body.case === "typedMethodRequest" &&
        frame.body.method === "authAccount",
    );
  const last = pending[pending.length - 1];
  expect(last, "还没有 auth.account 发出去").toBeTruthy();
  connection.listener?.onFrame?.(
    ProtobufRpcCodec.encodeTypedMethodResponse(
      last.id,
      rpcMethods.authAccount,
      { ok: true },
    ),
  );
}

function setup(credential: () => string | Promise<string>): {
  client: RelayClient;
  connection: FakeConnection;
} {
  const connection = new FakeConnection();
  const client = new RelayClient({
    connection,
    target: machineTarget("fp-daemon"),
    credential,
  });
  return { client, connection };
}

describe("通道握手的凭据", () => {
  it("每一次握手都现取：换 socket 之后带的是新票，不是建通道时那张", async () => {
    const tickets = ["ticket-1", "ticket-2"];
    let minted = 0;
    const { client, connection } = setup(() =>
      Promise.resolve(tickets[minted++]),
    );

    const connected = client.connect();
    await vi.waitFor(() => expect(credentialsSent(connection)).toHaveLength(1));
    answerAuth(connection);
    await connected;
    expect(credentialsSent(connection)).toEqual(["ticket-1"]);

    // 换 socket：连接那一层重连上之后逐条通道重新声明目标，再让通道自己重做握手。
    connection.listener?.onConnectionState?.("reconnecting");
    connection.listener?.onOpen?.();

    await vi.waitFor(() => expect(credentialsSent(connection)).toHaveLength(2));
    answerAuth(connection);
    await vi.waitFor(() => expect(client.state).toBe("connected"));
    expect(credentialsSent(connection)).toEqual(["ticket-1", "ticket-2"]);
  });

  describe("握手失败之后", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("自己退让重试，而不是把这条通道永久钉在 reconnecting 上", async () => {
      let minted = 0;
      const { client, connection } = setup(() => {
        minted++;
        return minted === 1
          ? Promise.reject(new Error("relay: 换票失败"))
          : Promise.resolve("ticket-2");
      });

      await expect(client.connect()).rejects.toThrow();
      expect(client.state).toBe("reconnecting");
      expect(credentialsSent(connection)).toEqual([]);

      // 退让封顶 30 秒，推过封顶就一定轮到下一次。
      await vi.advanceTimersByTimeAsync(31_000);
      expect(credentialsSent(connection)).toEqual(["ticket-2"]);
      answerAuth(connection);
      await vi.waitFor(() => expect(client.state).toBe("connected"));
    });

    it("客户端关掉之后不再重试", async () => {
      const { client, connection } = setup(() =>
        Promise.reject(new Error("relay: 换票失败")),
      );

      await expect(client.connect()).rejects.toThrow();
      client.close();

      await vi.advanceTimersByTimeAsync(120_000);
      expect(credentialsSent(connection)).toEqual([]);
      expect(client.state).toBe("disconnected");
    });
  });
});
