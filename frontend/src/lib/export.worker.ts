import { renderDocx } from "./renderDocx";
self.onmessage = async (event: MessageEvent) => {
  try {
    self.postMessage({
      blob: await renderDocx(event.data.model, event.data.fonts),
    });
  } catch (e) {
    self.postMessage({
      error: e instanceof Error ? e.message : "Word packaging failed.",
    });
  }
};
