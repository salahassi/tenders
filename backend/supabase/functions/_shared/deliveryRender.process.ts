import { renderDeliveryDocx } from "./deliveryRenderer.ts";
const runtime = (
  globalThis as unknown as {
    Deno: {
      stdin: { readable: ReadableStream<Uint8Array> };
      stdout: { write(bytes: Uint8Array): Promise<number> };
      exit(code: number): never;
    };
  }
).Deno;
try {
  const model = JSON.parse(await new Response(runtime.stdin.readable).text());
  const bytes = await renderDeliveryDocx(model);
  let offset = 0;
  while (offset < bytes.length)
    offset += await runtime.stdout.write(bytes.subarray(offset));
} catch {
  runtime.exit(1);
}
