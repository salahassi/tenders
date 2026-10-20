import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HashRouter, MemoryRouter } from "react-router-dom";
import { afterEach, it, expect, vi } from "vitest";
import { useApp } from "../lib/store";
import ModelActivity from "./ModelActivity";
vi.mock("../lib/store", () => ({ useApp: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("shows validated failures with measured usage, unknown counts and linked records; filters and loads older attempts", async () => {
  const record = {
    id: "12",
    provider: "zai_free",
    model: "configured-glm",
    operation: "classify_opportunity",
    status: "failed",
    result_code: "MODEL_OUTPUT_INVALID",
    sent: true,
    actual_input: 123,
    actual_output: 8,
    thinking_tokens: null,
    started_at: "2026-10-18T10:00:00Z",
    duration_ms: 2500,
    opportunity_id: "00000000-0000-4000-8000-000000000123",
    opportunity_title: "Synthetic tender",
    proposal_id: "00000000-0000-4000-8000-000000000456",
    round_number: 2,
    worker_attempt: 3,
  };
  const request = vi.fn(async (path: string) => ({
    data: {
      records: [{ ...record, id: path.includes("cursor") ? "11" : "12" }],
      next_cursor: path.includes("cursor") ? null : "12",
    },
  }));
  vi.mocked(useApp).mockReturnValue({ backend: { request } } as any);
  render(
    <MemoryRouter
      initialEntries={["/jobs?opportunity=" + record.opportunity_id]}
    >
      <ModelActivity />
    </MemoryRouter>,
  );
  expect(await screen.findByText("configured-glm")).toBeInTheDocument();
  expect(screen.getByText("MODEL_OUTPUT_INVALID")).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Synthetic tender" }),
  ).toHaveAttribute("href", "/opportunities/" + record.opportunity_id);
  expect(screen.getByRole("link", { name: "Open proposal" })).toHaveAttribute(
    "href",
    "/proposals/" + record.proposal_id,
  );
  expect(screen.getByText(/Reasoning: Not reported/)).toBeInTheDocument();
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText("Model provider"), "zai_free");
  await waitFor(() =>
    expect(request.mock.calls.at(-1)?.[0]).toContain("provider=zai_free"),
  );
  await user.click(
    await screen.findByRole("button", { name: "Load older attempts" }),
  );
  await waitFor(() =>
    expect(request.mock.calls.at(-1)?.[0]).toContain("cursor=12"),
  );
  expect(
    within(screen.getByRole("table")).getAllByText("configured-glm"),
  ).toHaveLength(2);
});
it("surfaces read errors without claiming an empty or successful history", async () => {
  vi.mocked(useApp).mockReturnValue({
    backend: {
      request: vi.fn().mockRejectedValue(new Error("Access unavailable")),
    },
  } as any);
  render(
    <MemoryRouter>
      <ModelActivity />
    </MemoryRouter>,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Access unavailable",
  );
  expect(
    screen.queryByText("No model attempts match these filters."),
  ).not.toBeInTheDocument();
});

it("explains that a failed poll is an existing request and its duration is not generation time", async () => {
  vi.mocked(useApp).mockReturnValue({
    backend: {
      request: vi.fn(async () => ({
        data: {
          records: [
            {
              id: "1",
              provider: "gemini_free",
              model: "configured-model",
              operation: "analyze_chunk",
              status: "failed",
              result_code: "PROVIDER_REQUEST_INVALID",
              request_phase: "poll",
              sent: false,
              http_status: 400,
              duration_ms: 1520,
            },
          ],
          next_cursor: null,
        },
      })),
    },
  } as any);
  render(
    <MemoryRouter>
      <ModelActivity />
    </MemoryRouter>,
  );
  expect(
    await screen.findByText(
      "Retrieving an existing result · no new generation",
    ),
  ).toBeInTheDocument();
  expect(screen.getByText("1.52 s for this request")).toBeInTheDocument();
  expect(screen.getByText(/Not reported means unknown/)).toBeInTheDocument();
});

it("keeps a provider hash deep-link selected in the live DOM after loading", async () => {
  window.history.replaceState(null, "", "/#/jobs?provider=zai_free");
  const request = vi.fn(async () => ({
    data: { records: [], next_cursor: null },
  }));
  vi.mocked(useApp).mockReturnValue({ backend: { request } } as any);
  const view = render(
    <HashRouter>
      <ModelActivity />
    </HashRouter>,
  );
  await screen.findByText("No model attempts match these filters.");
  const select = screen.getByLabelText("Model provider") as HTMLSelectElement;
  expect(select.value).toBe("zai_free");
  expect(select.selectedOptions[0].text).toBe("z.ai");
  expect(request.mock.calls.length).toBeGreaterThan(0);
  view.unmount();
  window.history.replaceState(null, "", "/");
});

it("distinguishes a provider overload from an older 429 with no recorded cause", async () => {
  vi.mocked(useApp).mockReturnValue({
    backend: {
      request: vi.fn(async () => ({
        data: {
          records: [
            {
              id: "2",
              provider: "zai_free",
              model: "configured-model",
              operation: "connection_probe",
              status: "failed",
              http_status: 429,
              provider_error_code: "1305",
              provider_error_reason: "overloaded",
              result_code: "PROVIDER_QUOTA_WAIT",
            },
            {
              id: "1",
              provider: "zai_free",
              model: "configured-model",
              operation: "connection_probe",
              status: "failed",
              http_status: 429,
              result_code: "PROVIDER_QUOTA_WAIT",
            },
          ],
          next_cursor: null,
        },
      })),
    },
  } as any);
  render(
    <MemoryRouter>
      <ModelActivity />
    </MemoryRouter>,
  );
  expect(
    await screen.findByText("Provider servers temporarily overloaded"),
  ).toBeInTheDocument();
  expect(screen.getByText("1305")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Provider rejected the request (429); specific reason unavailable",
    ),
  ).toBeInTheDocument();
});
