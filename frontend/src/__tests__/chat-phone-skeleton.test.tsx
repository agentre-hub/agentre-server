import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@agentre-hub/agentre-ui";

import i18n from "@/i18n";
import { PhoneChatIndex } from "@/pages/chat/PhoneChatIndex";

/**
 * 审计第 15e 项：手机对话首页加载时的骨架用的是桌面行的几何（小圆点头像、窄行），
 * 加载完列表会跳一下。要用共享包的 phone 形态（64px 行、44px 圆角头像），和真实行一致。
 */
beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("手机对话首页的加载骨架", () => {
  it("还没取回来时，骨架是 phone 形态", () => {
    const noop = vi.fn();
    const { container } = render(
      <MemoryRouter>
        <ThemeProvider>
          <PhoneChatIndex
            scopeKey="all"
            scopeTitle="全部"
            subtitle={{ text: "" }}
            onOpenScope={noop}
            onCompose={noop}
            searchQuery=""
            onSearchChange={noop}
            searchCount={0}
            settled={false}
            rows={[]}
            filter="all"
            onFilterChange={noop}
            counts={{ attention: 0, running: 0, unread: 0 }}
            agents={[]}
            projects={[]}
            hideAgent={false}
            sessionPath={() => "/chat/x"}
            stopTurnOf={() => undefined}
            filterAgentOf={() => undefined}
            filterMachineOf={() => undefined}
            onDelete={noop}
            onSave={noop}
            hasOnlineMachine
            onFindOnMachine={noop}
            hasMore={false}
            loadingMore={false}
            loadMoreFailed={false}
            onLoadMore={noop}
          />
        </ThemeProvider>
      </MemoryRouter>,
    );
    const skeleton = container.querySelector(
      '[data-slot="session-row-skeleton"]',
    );
    expect(skeleton).not.toBeNull();
    expect(skeleton?.getAttribute("data-variant")).toBe("phone");
  });
});
