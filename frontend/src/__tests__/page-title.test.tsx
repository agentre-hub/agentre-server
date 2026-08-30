import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import PageTitle from "@/components/PageTitle";

describe("PageTitle", () => {
  it("渲染成一级标题", () => {
    render(<PageTitle>设备配对</PageTitle>);

    expect(
      screen.getByRole("heading", { level: 1, name: "设备配对" }),
    ).toBeTruthy();
  });
});
