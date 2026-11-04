import {
  renderDocx,
  type FontData,
} from "../../../../frontend/src/lib/renderDocx.ts";
import type { RenderModel } from "./export.ts";

type Runtime = { readFile(path: URL): Promise<Uint8Array> };
let bundledFonts: Promise<FontData> | undefined;
/** Fonts are image assets, never downloaded from the customer browser or a
 * third-party service. The same renderer is used by legacy browser exports. */
export async function renderDeliveryDocx(
  model: RenderModel,
): Promise<Uint8Array> {
  const runtime = (globalThis as unknown as { Deno: Runtime }).Deno;
  if (!bundledFonts)
    bundledFonts = Promise.all(
      (
        [
          "Amiri-Regular",
          "Amiri-Bold",
          "Carlito-Regular",
          "Carlito-Bold",
        ] as const
      ).map(
        async (name) =>
          [
            name,
            await runtime.readFile(
              new URL(
                `../../../../frontend/public/fonts/${name}.ttf`,
                import.meta.url,
              ),
            ),
          ] as const,
      ),
    )
      .then((entries) => Object.fromEntries(entries) as FontData)
      .catch((error) => {
        bundledFonts = undefined;
        throw error;
      });
  return new Uint8Array(
    await (await renderDocx(model, await bundledFonts)).arrayBuffer(),
  );
}
