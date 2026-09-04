import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as accountChannel from "@/lib/accountChannel";
import type { AccountChannelState } from "@/lib/accountChannel";
import {
  retryAccountChannel,
  useAccountChannel,
  useAccountChannelState,
} from "@/hooks/use-account-channel";

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

/** 只看灯的那种订阅者：不要「该拉了」，只要状态。 */
function Light() {
  const state = useAccountChannelState();
  return <span data-testid="light">{state}</span>;
}

/** 把一次状态变化送进共用的那条通道。 */
function deliverState(state: AccountChannelState): void {
  const call = mockedStart.mock.calls.at(-1);
  expect(call).toBeDefined();
  act(() => call![0].onState?.(state));
}

describe("useAccountChannelState", () => {
  it("与「该拉了」的订阅者共用同一条通道，不为了点灯多开一条", () => {
    const page = render(<Subscriber types={[PRESENCE]} onRefresh={vi.fn()} />);
    const light = render(<Light />);

    expect(mockedStart).toHaveBeenCalledTimes(1);

    // 两种订阅者都走光了才停：灯还亮着的时候把通道停掉，灯就再也不会变了。
    page.unmount();
    expect(stopped).toBe(0);
    light.unmount();
    expect(stopped).toBe(1);
  });

  it("只有灯的页面也能把通道拉起来", () => {
    render(<Light />);
    expect(mockedStart).toHaveBeenCalledTimes(1);
  });

  it("状态变了灯跟着变；起手是「连接中」而不是假装连上了", () => {
    render(<Light />);
    expect(screen.getByTestId("light").textContent).toBe("connecting");

    deliverState("connected");
    expect(screen.getByTestId("light").textContent).toBe("connected");

    deliverState("disconnected");
    expect(screen.getByTestId("light").textContent).toBe("disconnected");
  });

  it("后挂上来的灯读到的是当下的状态，不是初值", () => {
    render(<Subscriber types={[PRESENCE]} onRefresh={vi.fn()} />);
    deliverState("connected");

    // 状态是**事件**：这条通道早就连上了，晚到的订阅者等不到它再说一次。
    render(<Light />);
    expect(screen.getByTestId("light").textContent).toBe("connected");
  });

  it("重试换一条新的通道，并且当场退回「连接中」", () => {
    render(<Light />);
    deliverState("disconnected");

    act(() => retryAccountChannel());

    expect(stopped).toBe(1);
    expect(mockedStart).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("light").textContent).toBe("connecting");

    // 新那条是真的接上了：它说话灯就跟着变。
    deliverState("connected");
    expect(screen.getByTestId("light").textContent).toBe("connected");
  });
});

describe("通道压根起不来的时候那盏灯", () => {
  it("落在「未连接」上，而不是永远停在「连接中」", () => {
    mockedStart.mockImplementation(() => {
      throw new Error("WebSocket 构造失败");
    });

    render(<Light />);

    // 停在「连接中」的话，那颗「重新连接」永远不出现，用户手上一个可点的东西
    // 都没有——而这一态恰恰是唯一需要他动手的那一态。
    expect(screen.getByTestId("light").textContent).toBe("disconnected");
  });

  it("重试也起不来就还留在「未连接」上：按钮不会自己消失", () => {
    render(<Light />);
    deliverState("disconnected");
    mockedStart.mockImplementation(() => {
      throw new Error("WebSocket 构造失败");
    });

    act(() => retryAccountChannel());

    expect(screen.getByTestId("light").textContent).toBe("disconnected");
  });
});
