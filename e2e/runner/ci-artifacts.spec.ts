import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const workflow = readFileSync(
  resolve(import.meta.dirname, "../../.github/workflows/ci.yml"),
  "utf8",
);

test("CI failure evidence is redacted before artifact upload", () => {
  const redact = workflow.indexOf("redact E2E failure evidence");
  const upload = workflow.indexOf("actions/upload-artifact");

  expect(redact).toBeGreaterThan(-1);
  expect(upload).toBeGreaterThan(redact);
  expect(workflow).not.toMatch(
    /path:\s*\|[\s\S]*?e2e\/runtime\/\*\/server\.log/,
  );
  expect(workflow).toContain("e2e/redacted-failure-evidence/");
});
