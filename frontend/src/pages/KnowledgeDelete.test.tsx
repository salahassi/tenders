import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { useApp } from "../lib/store";
import Knowledge from "./Knowledge";
vi.mock("../lib/store", () => ({ useApp: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("requires a delete confirmation and archives only the selected note through its current server revision", async () => {
  const row = {
    revision: 3,
    title: "Synthetic company note",
    category: "company",
    content: "Synthetic note wording",
    evidence: "Synthetic reference",
  };
  const request = vi.fn(async () => ({ data: row }));
  const runCommand = vi.fn(async () => ({}));
  vi.mocked(useApp).mockReturnValue({
    state: {
      settings: { role: "Owner" },
      knowledgeDocuments: [],
      knowledge: [{ id: "note", ...row, verified: false }],
    },
    update: vi.fn(),
    notify: vi.fn(),
    ready: true,
    mode: "CONNECTED_FREE",
    backend: { request },
    runCommand,
    saving: false,
  } as any);
  render(
    <MemoryRouter>
      <Knowledge />
    </MemoryRouter>,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Delete note Synthetic company note" }),
  );
  expect(runCommand).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: /^Delete note$/ }),
  );
  expect(request).toHaveBeenCalledWith("/v1/knowledge/note");
  expect(runCommand).toHaveBeenCalledWith("knowledge.save", {
    id: "note",
    expected_revision: 3,
    title: row.title,
    category: row.category,
    content: row.content,
    evidence: row.evidence,
    enabled: false,
  });
});
