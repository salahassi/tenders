/** Bounded SSE assembly. Reasoning text is never stored or logged. */
export class ModelStreamError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export async function readModelStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  protocol: "chat" | "anthropic",
  progress: () => void,
): Promise<any> {
  const decoder = new TextDecoder();
  let buffer = "",
    size = 0,
    ended = false,
    text = "",
    toolUse = false;
  let id: string | undefined,
    model: string | undefined,
    finish: string | null = null;
  let usage: Record<string, unknown> = {};
  const event = (block: string) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    if (data === "[DONE]") {
      ended = true;
      return;
    }
    if (ended) throw new ModelStreamError("MODEL_OUTPUT_INVALID");
    const value = JSON.parse(data);
    if (value.error || value.type === "error")
      throw new ModelStreamError("MODEL_NETWORK_UNCERTAIN");
    id ??= value.id || value.message?.id;
    model ??= value.model || value.message?.model;
    if (protocol === "chat") {
      const choices = value.choices || [];
      if (choices.some((c: any) => c.index !== undefined && c.index !== 0))
        throw new ModelStreamError("MODEL_OUTPUT_INVALID");
      const choice = choices[0];
      if (typeof choice?.delta?.content === "string")
        text += choice.delta.content;
      toolUse ||= Boolean(
        choice?.delta?.tool_calls?.length || choice?.delta?.function_call,
      );
      finish = choice?.finish_reason ?? finish;
      if (value.usage) usage = value.usage;
      // Groq may report measured totals in x_groq on its final event.
      if (value.x_groq?.usage) usage = value.x_groq.usage;
    } else {
      if (value.type === "message_start") usage = value.message?.usage || {};
      if (value.type === "content_block_start") {
        toolUse ||= !["text", "thinking", "redacted_thinking"].includes(
          value.content_block?.type,
        );
        if (typeof value.content_block?.text === "string")
          text += value.content_block.text;
      }
      if (
        value.type === "content_block_delta" &&
        value.delta?.type === "text_delta"
      )
        text += value.delta.text || "";
      if (value.type === "message_delta") {
        finish = value.delta?.stop_reason ?? finish;
        usage = { ...usage, ...value.usage };
      }
      if (value.type === "message_stop") ended = true;
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      progress();
      size += value.length;
      if (size > 1048576) throw new ModelStreamError("MODEL_OUTPUT_TOO_LARGE");
      buffer += decoder.decode(value, { stream: true });
      // Normalize only complete CRLF pairs, including pairs split between chunks.
      buffer = buffer.replaceAll("\r\n", "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        event(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
      if (ended) break;
    }
    buffer += decoder.decode();
    // A partial last event is not a successfully completed stream.
    if (buffer.trim() && !buffer.trim().startsWith(":")) ended = false;
    return protocol === "chat"
      ? {
          id,
          model,
          usage,
          choices: [
            {
              message: {
                content: text,
                ...(toolUse ? { tool_calls: [{}] } : {}),
              },
              finish_reason: ended ? finish : null,
            },
          ],
        }
      : {
          id,
          model,
          usage,
          stop_reason: ended ? finish : null,
          content: [
            { type: "text", text },
            ...(toolUse ? [{ type: "tool_use" }] : []),
          ],
        };
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
