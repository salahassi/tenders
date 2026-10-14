import { File as NodeFile } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachReviewFile } from "./reviewAttachments";
import { clearLocalFiles, getLocalFile } from "./knowledgeFiles";
import { extractLocalDocument } from "./documents";

vi.mock("./documents", () => ({
  MAX_FILE_BYTES: 10 * 1024 * 1024,
  extractLocalDocument: vi.fn(),
}));
const file = (content: string | Uint8Array, name: string) =>
  new NodeFile(
    [typeof content === "string" ? content : new Uint8Array(content).buffer],
    name,
  ) as unknown as File;

describe("review attachment originals", () => {
  afterEach(async () => {
    vi.clearAllMocks();
    await clearLocalFiles();
  });
  it("retains Arabic and CSV text with the original", async () => {
    const result = await attachReviewFile(
      file("الدور,السعر\nمهندس,100", "rates.csv"),
    );
    expect(result.status).toBe("ready");
    expect(result.text).toContain("مهندس,100");
    expect(await getLocalFile(result.id)).toBeDefined();
  });
  it("keeps an accepted original when PDF text extraction fails", async () => {
    vi.mocked(extractLocalDocument).mockRejectedValueOnce(
      new Error("Encrypted or unreadable PDF"),
    );
    const result = await attachReviewFile(
      file("%PDF-1.7\n original PDF bytes", "source.pdf"),
    );
    expect(result.status).toBe("error");
    expect(result.text).toBe("");
    expect(await getLocalFile(result.id)).toBeDefined();
  });
  it("marks image originals as requiring processing without inventing text", async () => {
    const result = await attachReviewFile(
      file(
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]),
        "diagram.png",
      ),
    );
    expect(result.status).toBe("needs_processing");
    expect(result.text).toBe("");
    expect(await getLocalFile(result.id)).toBeDefined();
  });
  it("rejects unsupported or mismatched files before storing originals", async () => {
    await expect(
      attachReviewFile(file("program", "program.exe")),
    ).rejects.toThrow("Choose a PDF");
    await expect(
      attachReviewFile(file("This is not a PDF", "spoof.pdf")),
    ).rejects.toThrow("do not match");
  });
});
