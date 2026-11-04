import { AppError } from "../_shared/http.ts";

/** One API handler owns one process-local file working set. This does not
 * assert a cluster-wide limit, impose a model quota, or create a wait queue. */
export class HeavyFileAdmission {
  private occupied = false;

  acquire(signal: AbortSignal): HeavyFilePermit {
    signal.throwIfAborted();
    if (this.occupied)
      throw new AppError(
        503,
        "FILE_PROCESSING_BUSY",
        "Another file is being processed or downloaded. Please retry shortly.",
        null,
        true,
      );
    this.occupied = true;
    return new HeavyFilePermit(signal, () => {
      this.occupied = false;
    });
  }
}

export class HeavyFilePermit {
  private released = false;
  private response: Response | undefined;

  constructor(
    private readonly signal: AbortSignal,
    private readonly free: () => void,
  ) {}

  private release() {
    if (this.released) return;
    this.released = true;
    this.free();
  }

  /** Abort during an uncooperative context read must not admit a second large
   * read while the first still runs. The handler calls this when work settles. */
  finishWork() {
    if (!this.response) this.release();
  }

  retainThrough(response: Response): Response {
    if (response === this.response) return response;
    this.signal.throwIfAborted();
    if (this.released || this.response)
      throw new Error("File permit already settled");
    if (!response.body) {
      this.release();
      return response;
    }
    const reader = response.body.getReader();
    let terminal = false;
    let cancellation: Promise<void> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const cleanup = () => {
      this.signal.removeEventListener("abort", abort);
      reader.releaseLock();
      this.release();
    };
    const cancel = (reason?: unknown): Promise<void> => {
      if (cancellation) return cancellation;
      if (terminal) return Promise.resolve();
      terminal = true;
      cancellation = reader.cancel(reason).finally(cleanup);
      return cancellation;
    };
    const abort = () => {
      if (!terminal) controller.error(this.signal.reason);
      // A disconnected consumer must not strand the permit. Retain it until
      // the underlying response source has actually stopped.
      void cancel(this.signal.reason).catch(() => {});
    };
    const body = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value;
        },
        async pull(value) {
          try {
            const next = await reader.read();
            if (terminal) return;
            if (next.done) {
              terminal = true;
              value.close();
              cleanup();
            } else value.enqueue(next.value);
          } catch (error) {
            if (!terminal) {
              terminal = true;
              value.error(error);
              cleanup();
            }
          }
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    // Zero prefetch matters: enqueueing the whole file into a response queue
    // must not release the permit before the downstream consumer drains it.
    this.response = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    this.signal.addEventListener("abort", abort, { once: true });
    if (this.signal.aborted) abort();
    return this.response;
  }
}

export { isHeavyFileRequest } from "../_shared/heavyFileProjection.ts";
