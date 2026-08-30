import type { APIResponse, Page } from "@playwright/test";

import { expect, readHandoff, readOracle } from "./app";

interface WriteReceipt {
  sync_id: string;
  version: number;
}

interface WorkspaceJourney {
  department: WriteReceipt;
  agent: WriteReceipt;
  project: WriteReceipt;
  member: WriteReceipt;
  issue: WriteReceipt;
}

function successfulData<T>(response: APIResponse, body: unknown): T {
  expect(
    response.ok(),
    `HTTP ${response.status()}: ${JSON.stringify(body)}`,
  ).toBe(true);
  expect(body).toMatchObject({ code: 0 });
  return (body as { data: T }).data;
}

async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
  const response = await page.request.post(path, {
    headers: { "X-CSRF-Token": readHandoff().csrfToken },
    data,
  });
  return successfulData<T>(response, await response.json());
}

export async function driveWorkspaceJourney(page: Page) {
  const suffix = readHandoff().runID;
  const names = {
    department: `webe2e department ${suffix}`,
    agent: `webe2e agent ${suffix}`,
    project: `webe2e project ${suffix}`,
    issue: `webe2e issue ${suffix}`,
  };

  const journey = {} as WorkspaceJourney;
  try {
    journey.department = await post(page, "/v1/workspace/org/departments", {
      name: names.department,
    });
    journey.agent = await post(page, "/v1/workspace/org/agents", {
      name: names.agent,
      department_sync_id: journey.department.sync_id,
    });
    journey.project = await post(page, "/v1/workspace/org/projects", {
      name: names.project,
    });
    journey.member = await post(page, "/v1/workspace/org/project-members", {
      project_sync_id: journey.project.sync_id,
      agent_sync_id: journey.agent.sync_id,
    });
    journey.issue = await post(page, "/v1/workspace/issues", {
      title: names.issue,
      stage: "todo",
      project_sync_id: journey.project.sync_id,
      agent_sync_id: journey.agent.sync_id,
    });

    const oracle = readOracle();
    for (const [kind, receipt] of [
      ["department", journey.department],
      ["agent", journey.agent],
      ["project", journey.project],
      ["project_agent", journey.member],
      ["issue", journey.issue],
    ] as const) {
      expect(oracle.sync_objects).toContainEqual({
        sync_id: receipt.sync_id,
        kind,
        version: receipt.version,
        deleted_at: 0,
      });
    }

    await page.goto(`/org/agent/${journey.agent.sync_id}`);
    await expect(page.getByTestId("org-layout")).toBeVisible();
    await expect(page.getByText(names.department).first()).toBeVisible();
    await expect(page.getByText(names.agent).first()).toBeVisible();
    await page.reload();
    await expect(page.getByText(names.agent).first()).toBeVisible();

    await page.goto("/issues");
    await expect(page.getByTestId("issues-page")).toBeVisible();
    await expect(page.getByText(names.issue).first()).toBeVisible();
    await page.reload();
    await expect(page.getByText(names.issue).first()).toBeVisible();
  } finally {
    if (journey.issue)
      await post(page, "/v1/workspace/issues/delete", {
        sync_id: journey.issue.sync_id,
      });
    if (journey.member)
      await post(page, "/v1/workspace/org/project-members/delete", {
        sync_id: journey.member.sync_id,
      });
    if (journey.project)
      await post(page, "/v1/workspace/org/projects/delete", {
        sync_id: journey.project.sync_id,
      });
    if (journey.agent)
      await post(page, "/v1/workspace/org/agents/delete", {
        sync_id: journey.agent.sync_id,
      });
    if (journey.department)
      await post(page, "/v1/workspace/org/departments/delete", {
        sync_id: journey.department.sync_id,
      });
  }
}
