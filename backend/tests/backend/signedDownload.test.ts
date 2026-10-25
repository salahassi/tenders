import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Backend,
  environment,
  type BackendEnvironment,
} from "../../supabase/functions/_shared/backend";

const sdk = vi.hoisted(() => ({
  sign: vi.fn(),
  from: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ storage: { from: sdk.from } })),
}));

const internal = "http://gateway:8081";
const storagePath = "/storage/v1/object/sign/tenderdesk-private/workspace/document.txt";
const signedQuery = "?token=signature%2Fpart%2Btail%3D&download=report%20ar.docx";
const privateSignedUrl = internal + storagePath + signedQuery;
const env = (): BackendEnvironment =>
  environment((name) => ({
    SUPABASE_URL: internal,
    SUPABASE_ANON_KEY: "synthetic-public-key",
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key",
    APP_PUBLIC_API_URL: "https://app.example.test",
  })[name]);

beforeEach(() => {
  vi.clearAllMocks();
  sdk.from.mockReturnValue({ createSignedUrl: sdk.sign });
  sdk.sign.mockResolvedValue({ data: { signedUrl: privateSignedUrl }, error: null });
});

describe("public original-file download links", () => {
  it("rewrites the private gateway origin while preserving the exact escaped signature and path", async () => {
    const backend = new Backend(env());
    expect(await backend.download("workspace/document.txt")).toBe(
      "https://app.example.test" + storagePath + signedQuery,
    );
    expect(sdk.from).toHaveBeenCalledWith("tenderdesk-private");
    expect(sdk.sign).toHaveBeenCalledWith("workspace/document.txt", 300);
  });

  it("retains hosted behavior when a separate public API origin is absent", async () => {
    const hosted = "https://project.example.test" + storagePath + signedQuery;
    sdk.sign.mockResolvedValue({ data: { signedUrl: hosted }, error: null });
    const backend = new Backend({ ...env(), url: "https://project.example.test", publicApiUrl: undefined });
    expect(await backend.download("workspace/document.txt")).toBe(hosted);
  });

  it.each([
    "https://foreign.example.test" + storagePath + signedQuery,
    "http://gateway:8082" + storagePath + signedQuery,
    "https://gateway:8081" + storagePath + signedQuery,
    "http://user:password@gateway:8081" + storagePath + signedQuery,
    internal + "/storage/v1/object/public/tenderdesk-private/file.txt?token=signature",
    internal + "/auth/v1/user?token=signature",
    internal + "/storage/v1/object/sign/../public/file.txt?token=signature",
    internal + storagePath,
    privateSignedUrl + "#fragment",
    "/storage/v1/object/sign/tenderdesk-private/file.txt?token=signature",
  ])("refuses an unexpected Storage origin or signed route: %s", async (url) => {
    sdk.sign.mockResolvedValue({ data: { signedUrl: url }, error: null });
    await expect(new Backend(env()).download("workspace/document.txt")).rejects.toMatchObject({
      status: 503,
      code: "DOWNLOAD_UNAVAILABLE",
      message: "The original could not be opened.",
    });
  });

  it.each([
    "http://app.example.test",
    "https://user:password@app.example.test",
    "https://app.example.test/path",
    "https://app.example.test/?credential=value",
    "https://app.example.test/#fragment",
    "https://app.example.test/path/..",
    "https://app.example.test/?",
    "https://app.example.test/#",
    "not-a-url",
  ])("refuses an invalid public API origin: %s", async (publicApiUrl) => {
    await expect(new Backend({ ...env(), publicApiUrl }).download("workspace/document.txt")).rejects.toMatchObject({
      status: 503,
      code: "DOWNLOAD_UNAVAILABLE",
    });
  });

  it("retains the existing failure boundary when Storage cannot sign the original", async () => {
    sdk.sign.mockResolvedValue({ data: null, error: { message: "private upstream diagnostic" } });
    await expect(new Backend(env()).download("workspace/document.txt")).rejects.toMatchObject({
      status: 503,
      code: "DOWNLOAD_UNAVAILABLE",
      message: "The original could not be opened.",
    });
  });
});
