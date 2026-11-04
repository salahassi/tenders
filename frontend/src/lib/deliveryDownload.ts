import type { BackendClient } from "./backendClient";
import { sha256 } from "./connectedExport";

export interface DeliveryPackage {
  snapshot: {
    id: string;
    proposal_id?: string;
    delivery_revision?: number;
    ordinal: number;
    language: "ar" | "en";
    content_state: string;
    input_state: string;
    assurance_state: string;
    gap_count: number;
  };
  status: "preparing" | "ready" | "blocked";
  artifacts: {
    id: string;
    volume: string;
    status: string;
    content_hash: string | null;
    expected_size: number | null;
    original_name: string;
    mime_type: string;
  }[];
  job?: {
    status: string;
    error_code: string | null;
    next_attempt_at: string | null;
  };
}

export async function downloadDeliveryPackage(
  client: BackendClient,
  saved: DeliveryPackage,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (
    saved.status !== "ready" ||
    !saved.artifacts.length ||
    saved.artifacts.some((item) => item.status !== "ready")
  )
    throw new Error("The complete saved draft package is not ready yet.");
  const volumes = saved.artifacts.map((item) => item.volume).sort();
  if (
    JSON.stringify(volumes) !== '["combined"]' &&
    JSON.stringify(volumes) !== '["financial","technical"]'
  )
    throw new Error("The saved draft volume set is invalid.");
  // Fetch and verify the whole package before triggering any browser download.
  // An absent second volume can never produce a complete-package success.
  const files = await Promise.all(
    saved.artifacts.map(async (artifact) => {
      const blob = await client.downloadDeliveryArtifact(artifact.id, signal);
      signal?.throwIfAborted();
      const hash = await sha256(blob);
      signal?.throwIfAborted();
      if (
        blob.size !== Number(artifact.expected_size) ||
        hash !== artifact.content_hash
      )
        throw new Error("Downloaded draft bytes differ from the saved file.");
      return { blob, name: artifact.original_name };
    }),
  );
  for (const file of files) {
    signal?.throwIfAborted();
    const url = URL.createObjectURL(file.blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      signal?.throwIfAborted();
      anchor.click();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
}
