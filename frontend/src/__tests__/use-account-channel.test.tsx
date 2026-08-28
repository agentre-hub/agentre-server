import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as accountChannel from "@/lib/accountChannel";
import { useAccountChannel } from "@/hooks/use-account-channel";

vi.mock("@/lib/accountChannel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountChannel")>();
  return { ...actual, startAccountChannel: vi.fn() };
});

const mockedStart = vi.mocked(accountChannel.startAccountChannel);

const {
  AccountChannelDevicePresence: PRESENCE,
  AccountChannelMirrorChanged: MIRROR,
  AccountChannelSyncVersion: SYNC,
} = accountChannel;

function Subscriber({
  types,
  onRefresh,
}: {
  types: readonly string[];
  onRefresh: () => void;
}) {
  useAccountChannel(types, onRefresh);
  return null;
}

let stop: () => void;
let stopped: number;

/** 把一条信号（或 null＝建连/轮询那一路）送进共用的那条通道。 */
function deliver(signalType: string | null): void {
  const call = mockedStart.mock.calls.at(-1);
  expect(call).toBeDefined();
  call![0].onRefresh(signalType);
}

beforeEach(() => {
  stopped = 0;
  stop = () => {
    stopped += 1;
  };
  mockedStart.mockReset();
  mockedStart.mockImplementation(() => ({ stop }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useAccountChannel", () => {
  it("一个标签页只开一条通道，订阅者共用；最后一个走了才停", () => {
    const shell = render(<Subscriber types={[PRESENCE]} onRefresh={vi.fn()} />);
    const page = render(<Subscriber types={[MIRROR]} onRefresh={vi.fn()} />);

    // 每个订阅者各开一条的话，一个标签页就是好几条 websocket，而 server 那边
    // 一条连接就是一份 Redis 订阅（accountchan_svc.Subscribe）。
    expect(mockedStart).toHaveBeenCalledTimes(1);

    shell.unmount();
    expect(stopped).toBe(0);
    page.unmount();
    expect(stopped).toBe(1);
  });

  it("信号按种类分发：不关心的那些不会把人喊醒", () => {
    const onPresence = vi.fn();
    const onMirror = vi.fn();
    render(<Subscriber types={[PRESENCE]} onRefresh={onPresence} />);
    render(<Subscriber types={[MIRROR]} onRefresh={onMirror} />);

    deliver(MIRROR);
    expect(onPresence).not.toHaveBeenCalled();
    expect(onMirror).toHaveBeenCalledTimes(1);

    deliver(PRESENCE);
    expect(onPresence).toHaveBeenCalledTimes(1);
    expect(onMirror).toHaveBeenCalledTimes(1);

    // 这一版还不认识的种类：谁都不喊，但通道照旧活着（accountChannel 那一层已经
    // 把它挡掉了，这里再挡一道是因为分发用的是订阅者自己的名单）。
    deliver("some_future_notification");
    expect(onPresence).toHaveBeenCalledTimes(1);
    expect(onMirror).toHaveBeenCalledTimes(1);
  });

  it("建连、重连与兜底轮询喊醒所有人：那三条路不知道落后的是哪一类", () => {
    const onPresence = vi.fn();
    const onSync = vi.fn();
    render(<Subscriber types={[PRESENCE]} onRefresh={onPresence} />);
    render(<Subscriber types={[SYNC]} onRefresh={onSync} />);

    deliver(null);

    expect(onPresence).toHaveBeenCalledTimes(1);
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it("重渲染换了个回调不重连，但喊的是最新那个", () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = render(<Subscriber types={[MIRROR]} onRefresh={first} />);

    // 页面传进来的多半是每次渲染新建的闭包。为它重建一次 websocket 意味着
    // 每渲染一次就断连重连一次——通道会一直在建连，而不是一直连着。
    view.rerender(<Subscriber types={[MIRROR]} onRefresh={second} />);
    expect(mockedStart).toHaveBeenCalledTimes(1);
    expect(stopped).toBe(0);

    deliver(MIRROR);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("同样内容的新数组不算换种类：页面写的是字面量", () => {
    const onRefresh = vi.fn();
    const view = render(<Subscriber types={[MIRROR]} onRefresh={onRefresh} />);

    view.rerender(<Subscriber types={[MIRROR]} onRefresh={onRefresh} />);

    expect(mockedStart).toHaveBeenCalledTimes(1);
    deliver(MIRROR);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("换了种类之后按新名单收信，通道不必重开", () => {
    const onRefresh = vi.fn();
    const view = render(<Subscriber types={[MIRROR]} onRefresh={onRefresh} />);

    view.rerender(<Subscriber types={[PRESENCE]} onRefresh={onRefresh} />);

    expect(mockedStart).toHaveBeenCalledTimes(1);
    deliver(MIRROR);
    expect(onRefresh).not.toHaveBeenCalled();
    deliver(PRESENCE);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("通道起不来也不弄崩页面：它本来就允许不在", () => {
    mockedStart.mockImplementation(() => {
      throw new Error("WebSocket 构造失败");
    });

    const view = render(<Subscriber types={[SYNC]} onRefresh={vi.fn()} />);

    expect(() => view.unmount()).not.toThrow();
  });

  it("上一次没起来，下一个订阅者进来时再试一次", () => {
    mockedStart.mockImplementationOnce(() => {
      throw new Error("WebSocket 构造失败");
    });

    render(<Subscriber types={[SYNC]} onRefresh={vi.fn()} />);
    const onRefresh = vi.fn();
    render(<Subscriber types={[PRESENCE]} onRefresh={onRefresh} />);

    expect(mockedStart).toHaveBeenCalledTimes(2);
    deliver(PRESENCE);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
