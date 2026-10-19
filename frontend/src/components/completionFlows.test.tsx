import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { useApp } from "../lib/store";
import SourceConfiguration from "./SourceConfiguration";
import TenderCostInput from "./TenderCostInput";
import { tenderCurrency } from "../lib/tenderCurrency";
vi.mock("../lib/store", () => ({ useApp: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("retains the reviewed listing adapter and catalog metadata when editing collection settings", async () => {
  const runCommand = vi.fn(async () => ({}));
  vi.mocked(useApp).mockReturnValue({
    runCommand,
    state: { settings: { role: "Owner" } },
    notify: vi.fn(),
    saving: false,
  } as any);
  render(
    <SourceConfiguration
      source={
        {
          id: "synthetic",
          revision: 2,
          url: "https://www.najah.edu/ar/tenders/",
          type: "link_directory",
          approvedHosts: ["www.najah.edu"],
          policy: "Reviewed public listing",
          pollHours: 6,
          adapterConfig: {
            official_listing: "custom-source",
            extraction: { version: 1, buyer: "Synthetic configurable buyer" },
            catalog: { key: "ps-najah" },
          },
        } as any
      }
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Save settings and pause" }),
  );
  expect(runCommand).toHaveBeenCalledWith(
    "source.configure",
    expect.objectContaining({
      adapter_config: {
        official_listing: "custom-source",
        extraction: { version: 1, buyer: "Synthetic configurable buyer" },
        catalog: { key: "ps-najah" },
      },
    }),
  );
});
it("suggests tender-country currencies without assigning a currency to an unknown country", () => {
  for (const [country, currency] of [
    ["SA", "SAR"],
    ["JO", "JOD"],
    ["PS", "ILS"],
    ["", ""],
  ]) {
    const state = {
      opportunities: [{ id: "o", sourceId: "s" }],
      sources: [{ id: "s", tags: [`country:${country}`] }],
    } as any;
    expect(tenderCurrency(state, "o")).toBe(currency);
  }
});
it("saves tender-specific costs without a pre-existing catalog and resumes approval without duplicate rate creation", async () => {
  let fails = true;
  const runCommand = vi.fn(async (operation: string) => {
    if (operation === "rate.save")
      return { id: "rate-1", revision: 1, unit: "day" };
    if (fails) {
      fails = false;
      throw Error("Temporary approval failure");
    }
    return { id: "rate-1", revision: 2 };
  });
  vi.mocked(useApp).mockReturnValue({
    runCommand,
    state: { settings: { role: "Owner" } },
  } as any);
  const onSaved = vi.fn(async () => {});
  render(
    <TenderCostInput
      description="Tender integration work"
      currency="JOD"
      opportunityId="00000000-0000-4000-8000-000000000001"
      onSaved={onSaved}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Set cost for this tender" }),
  );
  await userEvent.type(screen.getByLabelText("Unit cost (JOD)"), "180");
  await userEvent.type(screen.getByLabelText("Cost unit"), "day");
  await userEvent.type(
    screen.getByLabelText("Cost basis / quotation reference"),
    "Documented tender effort estimate",
  );
  await userEvent.type(
    screen.getByLabelText("Cost valid through"),
    "2027-01-01",
  );
  expect(
    screen.getByRole("button", { name: "Save and approve tender cost" }),
  ).toBeDisabled();
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(
    screen.getByRole("button", { name: "Save and approve tender cost" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Temporary approval failure",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Save and approve tender cost" }),
  );
  await waitFor(() =>
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rate-1", approved: true }),
    ),
  );
  expect(
    runCommand.mock.calls.filter(([op]) => op === "rate.save"),
  ).toHaveLength(1);
  const approvals = runCommand.mock.calls.filter(
    ([op]) => op === "rate.approve",
  );
  expect(approvals).toHaveLength(2);
  expect(approvals[0]).toEqual(approvals[1]);
});
it("does not offer Owner cost approval to a Reviewer", () => {
  vi.mocked(useApp).mockReturnValue({
    runCommand: vi.fn(),
    state: { settings: { role: "Reviewer" } },
  } as any);
  render(
    <TenderCostInput
      description="Scope"
      currency="JOD"
      opportunityId="o"
      onSaved={async () => {}}
    />,
  );
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
