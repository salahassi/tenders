import { packBackup, unpackBackup } from "./backupFormat";
self.onmessage = async ({ data }: MessageEvent) => {
  try {
    self.postMessage({
      result:
        data.action === "pack"
          ? await packBackup(data.bundle)
          : await unpackBackup(data.file),
    });
  } catch (e) {
    self.postMessage({
      error: e instanceof Error ? e.message : "Backup verification failed.",
    });
  }
};
