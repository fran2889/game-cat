import { readFileSync, statSync } from "node:fs";

/**
 * A whole-file read that avoids accepting a snapshot Steam rewrote mid-read
 * (spec §8; AC-L14). If every attempt observes a change, the file is reported
 * as incomplete instead of returning the last, possibly torn, snapshot.
 */

export interface StableReadWarning {
  code: string;
  message: string;
  path?: string;
}

export interface StableReadIo {
  statSync(path: string): { mtimeMs: number; size: number };
  readFileSync(path: string): string;
}

const DEFAULT_IO: StableReadIo = {
  statSync: (path) => {
    const stats = statSync(path);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  },
  readFileSync: (path) => readFileSync(path, "utf8"),
};

export function readStable(
  path: string,
  warnings: StableReadWarning[],
  attempts = 3,
  io: StableReadIo = DEFAULT_IO,
): string | null {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const before = io.statSync(path);
      const text = io.readFileSync(path);
      const after = io.statSync(path);
      if (before.mtimeMs === after.mtimeMs && before.size === after.size) {
        return text;
      }
    } catch (error) {
      warnings.push({
        code: "file_unreadable",
        message: `Could not read ${path}: ${(error as Error).message}`,
        path,
      });
      return null;
    }
  }

  warnings.push({
    code: "file_changed_during_read",
    message: `${path} changed on every read attempt; treating the source as incomplete.`,
    path,
  });
  return null;
}
