import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { FileConfig } from "./load.ts";

/**
 * Write `<data-dir>/config.json` atomically: same-directory temporary file,
 * 0600 permissions, fsync, then rename over the target. A crash leaves either
 * the old or the new file, never a partial secret.
 */
export function writeConfigAtomically(
  configPath: string,
  config: FileConfig,
  platform: NodeJS.Platform = process.platform,
): void {
  const tempPath = join(
    dirname(configPath),
    `.config.json.tmp-${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
  );
  const text = `${JSON.stringify(config, null, 2)}\n`;

  let descriptor: number | null = null;
  try {
    descriptor = openSync(tempPath, "wx", 0o600);
    writeFileSync(descriptor, text, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    if (platform !== "win32") {
      chmodSync(tempPath, 0o600);
    }
    renameSync(tempPath, configPath);
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Best effort while unwinding.
      }
    }
    try {
      unlinkSync(tempPath);
    } catch {
      // The temp file may never have been created.
    }
    throw error;
  }
}
