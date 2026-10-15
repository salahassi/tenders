import type { BackendClient } from "./backendClient";
import { downloadLocalFile } from "./knowledgeFiles";
export async function downloadOriginal(
  client: BackendClient | undefined,
  id: string,
  name: string,
) {
  if (!client) return downloadLocalFile(id, name);
  const { data } = await client.request<{ url: string }>(
    `/v1/documents/${id}/download`,
  );
  const response = await fetch(data.url);
  if (!response.ok) throw new Error("The original could not be downloaded.");
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
