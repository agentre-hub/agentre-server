import { describe, expect, it } from "vitest";

import { mergeSessionCopies } from "@/lib/sessionMerge";

const desktopSummary = {
  sessionId: 42,
  peerFingerprint: "fp-desktop",
  title: "Complete desktop title",
  agentSyncId: "ag-1",
  lifecycleState: "idle",
  latestSeq: 9,
};

const agentredSummary = {
  ...desktopSummary,
  title: "Partial agentred title",
  latestSeq: 4,
};

describe("duplicate session merge", () => {
  it("merges by peer fingerprint plus session id and prefers the desktop copy", () => {
    const merged = mergeSessionCopies(
      [
        {
          sourceFingerprint: "fp-agentred",
          sourceKind: "agentred",
          summary: agentredSummary,
        },
        {
          sourceFingerprint: "fp-desktop",
          sourceKind: "desktop",
          summary: desktopSummary,
        },
      ],
      new Set(["fp-desktop"]),
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].sourceKind).toBe("desktop");
    expect(merged[0].summary.title).toBe("Complete desktop title");
    expect(merged[0].historyIncomplete).toBe(false);

    const reversed = mergeSessionCopies(
      [
        {
          sourceFingerprint: "fp-desktop",
          sourceKind: "desktop",
          summary: desktopSummary,
        },
        {
          sourceFingerprint: "fp-agentred",
          sourceKind: "agentred",
          summary: agentredSummary,
        },
      ],
      new Set(["fp-desktop"]),
    );
    expect(reversed).toHaveLength(1);
    expect(reversed[0].sourceKind).toBe("desktop");
  });

  it("does not merge equal session ids from different peer fingerprints", () => {
    const merged = mergeSessionCopies([
      {
        sourceFingerprint: "fp-agentred-a",
        sourceKind: "agentred",
        summary: agentredSummary,
      },
      {
        sourceFingerprint: "fp-agentred-b",
        sourceKind: "agentred",
        summary: { ...agentredSummary, peerFingerprint: "fp-other" },
      },
    ]);

    expect(merged).toHaveLength(2);
  });

  it("falls back to the agentred copy and marks its retained history incomplete", () => {
    const merged = mergeSessionCopies(
      [
        {
          sourceFingerprint: "fp-agentred",
          sourceKind: "agentred",
          summary: agentredSummary,
        },
      ],
      new Set(["fp-desktop"]),
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].sourceKind).toBe("agentred");
    expect(merged[0].historyIncomplete).toBe(true);
  });
});
