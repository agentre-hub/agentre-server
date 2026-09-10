import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import Transcript from "@/components/session/Transcript";
import { createServerTranscriptPorts } from "@/lib/transcriptPorts";
import { reduceFrames, type TranscriptFrame } from "@agentre-hub/agentre-ui";

import "@/i18n";

/**
 * 转录里的文件路径能不能点开预览（规格 2026-09-08「入口」）。
 *
 * 两道判定都在包里，本站不新增口径；这里测的是**接缝**：宿主有没有把实况 cwd
 * 交给转录、有没有把 `previewFile` 接上。cwd 缺席时链接必须维持死文本 —— 那
 * 正是那台机器离线时的样子。
 */

function frames(...events: Record<string, unknown>[]): TranscriptFrame[] {
  return events.map((event, i) => ({ sessionId: 1, event, seq: i + 1 }));
}

function renderTranscript(opts: {
  cwd?: string;
  previewFile?: (sessionId: number, path: string) => boolean;
}) {
  const events = [
    { kind: "text_delta", text: "改完了，见 [说明](/srv/work/docs/a.md)。" },
  ];
  return render(
    <Transcript
      messages={reduceFrames(frames(...events), 1)}
      sessionId={1}
      cwd={opts.cwd}
      ports={
        opts.previewFile
          ? ({ previewFile: opts.previewFile } as never)
          : undefined
      }
    />,
  );
}

describe("转录里的文件路径", () => {
  it("有 cwd 且宿主接了端口时，点它把 cwd 内的相对路径交给宿主", () => {
    const previewFile = vi.fn().mockReturnValue(true);
    renderTranscript({ cwd: "/srv/work", previewFile });

    fireEvent.click(screen.getByText("说明"));

    expect(previewFile).toHaveBeenCalledTimes(1);
    expect(previewFile.mock.calls[0][1]).toBe("docs/a.md");
  });

  it("cwd 缺席（那台机器离线）时不出入口，点了什么都不发生", () => {
    const previewFile = vi.fn().mockReturnValue(true);
    renderTranscript({ previewFile });

    fireEvent.click(screen.getByText("说明"));

    expect(previewFile).not.toHaveBeenCalled();
  });
});

// 端口的**在不在**本身就是能力探测（包的既有约定）：宿主没接预览就不该有这个
// 端口，链接因此整个不出入口，而不是出一个点了没反应的入口。
describe("previewFile 端口的能力探测", () => {
  it("宿主给了预览动作才有这个端口", () => {
    const withPreview = createServerTranscriptPorts({
      submitToolPermission: async () => undefined,
      submitAnswer: async () => undefined,
      previewFile: () => true,
    });
    const without = createServerTranscriptPorts({
      submitToolPermission: async () => undefined,
      submitAnswer: async () => undefined,
    });

    expect(typeof withPreview.previewFile).toBe("function");
    expect(without.previewFile).toBeUndefined();
  });
});
