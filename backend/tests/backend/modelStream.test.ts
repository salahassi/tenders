// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { FreeModelProvider } from "../../supabase/functions/_shared/model";
import { readModelStream } from "../../supabase/functions/_shared/modelStream";
import type { ModelEnvironment } from "../../supabase/functions/_shared/model";

const env: ModelEnvironment = {
  provider: "zai_free",
  model: "user-supplied-model",
  projectRef: "synthetic-project",
  key: "synthetic",
};
afterEach(() => vi.useRealTimers());
const data = (value: unknown) =>
  `data: ${typeof value === "string" ? value : JSON.stringify(value)}\r\n\r\n`;
const end =
  data({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  }) + data("[DONE]");
const content = (text: string) =>
  data({
    id: "synthetic-stream",
    model: env.model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  });

it("assembles fragmented UTF-8/SSE frames, retains measured usage and excludes thinking text", async () => {
  const raw =
    content('{"نص":"') +
    data({ choices: [{ delta: { reasoning_content: "private reasoning" } }] }) +
    content('جاهز"}') +
    end;
  const bytes = new TextEncoder().encode(raw);
  const reader = new ReadableStream<Uint8Array>({
    start(c) {
      for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
      c.close();
    },
  }).getReader();
  const result = await readModelStream(reader, "chat", () => {});
  expect(result.choices[0].message.content).toBe('{"نص":"جاهز"}');
  expect(result.choices[0].finish_reason).toBe("stop");
  expect(result.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7 });
  expect(JSON.stringify(result)).not.toContain("private reasoning");
});

it("does not accept a disconnected stream as complete even if text is valid JSON", async () => {
  const provider = new FreeModelProvider(
    env,
    async () =>
      new Response(content('{"status":"ready"}'), {
        headers: { "content-type": "text/event-stream" },
      }),
    120000,
    true,
  );
  expect(
    (await provider.generate("connection_probe", "JSON", {})).complete,
  ).toBe(false);
});

it("retains Anthropic cache and output usage while excluding reasoning", async () => {
  const frames = [
    {
      type: "message_start",
      message: {
        id: "synthetic",
        usage: {
          input_tokens: 8,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
        },
      },
    },
    { type: "content_block_start", content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      delta: { type: "text_delta", text: '{"status":"ready"}' },
    },
    {
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking: "private reasoning" },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 7 },
    },
    { type: "message_stop" },
  ]
    .map(data)
    .join("");
  const provider = new FreeModelProvider(
    { ...env, provider: "anthropic" },
    async () =>
      new Response(frames, {
        headers: { "content-type": "text/event-stream" },
      }),
    120000,
    true,
  );
  expect(await provider.generate("connection_probe", "JSON", {})).toEqual({
    kind: "completed_candidate",
    text: '{"status":"ready"}',
    complete: true,
    usage: { input: 13, output: 7, thinking: null },
  });
});

it.each(["progress", "idle", "ceiling"] as const)(
  "bounds a long stream by activity and total time: %s",
  async (scenario) => {
    vi.useFakeTimers();
    const send = vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).stream).toBe(true);
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          init?.signal?.addEventListener("abort", () =>
            c.error(new Error("aborted")),
          );
          if (scenario !== "idle") {
            setTimeout(
              () => c.enqueue(new TextEncoder().encode(content('{"status":'))),
              60000,
            );
            setTimeout(() => {
              c.enqueue(
                new TextEncoder().encode(
                  content('"ready"}') + (scenario === "progress" ? end : ""),
                ),
              );
              if (scenario === "progress") c.close();
            }, 100000);
          }
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const provider = new FreeModelProvider(env, send, 120000, true);
    const result = provider.generate("connection_probe", "JSON", {}).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(
      scenario === "idle" ? 90000 : scenario === "progress" ? 100000 : 120000,
    );
    const outcome = await result;
    if (scenario === "progress") {
      expect(outcome).toMatchObject({
        value: {
          complete: true,
          text: '{"status":"ready"}',
          usage: { input: 11, output: 7 },
        },
      });
    } else {
      expect(outcome).toMatchObject({
        error: { code: "MODEL_NETWORK_UNCERTAIN" },
      });
      expect(provider.telemetry.provider_error_reason).toBe(
        scenario === "idle" ? "stream_idle_timeout" : "request_timeout",
      );
    }
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it("rejects oversized streams and provider error events without exposing their contents", async () => {
  for (const raw of [
    content("x".repeat(1048576)),
    data({ error: { message: "private detail" } }),
  ]) {
    const provider = new FreeModelProvider(
      env,
      async () =>
        new Response(raw, {
          headers: { "content-type": "text/event-stream" },
        }),
      120000,
      true,
    );
    await expect(
      provider.generate("connection_probe", "JSON", {}),
    ).rejects.toMatchObject({
      code:
        raw.length > 1048576
          ? "MODEL_OUTPUT_TOO_LARGE"
          : "MODEL_NETWORK_UNCERTAIN",
    });
  }
});
