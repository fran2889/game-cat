import { chmodSync, closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { APP_VERSION } from "../shared/app.ts";
import { StartupError } from "./errors.ts";

/**
 * The diagnostic body of `<data-dir>/game-cat.lock`. The content is never the
 * authority; it exists so a human and the v4 wrapper can name the owning PID.
 */
export interface LockFileInfo {
  pid: number;
  /** Wall-clock time this lock was taken. */
  startedAt: string;
  /** Wall-clock start time of the owning process. */
  startTime: string;
  /** Linux /proc/<pid>/stat starttime, used to detect PID reuse. */
  procStartTicks?: string;
  app: string;
  version: string;
}

export interface AcquireLockOptions {
  lockPath: string;
  dataDir: string;
  /** Injectable for tests. Defaults to the current process and clock. */
  pid?: number;
  now?: Date;
  procStartTicks?: string | null;
}

export interface LockHandle {
  readonly path: string;
  readonly info: LockFileInfo;
  release(): void;
}

/**
 * Portable single-instance lock.
 *
 * §8.4 describes an exclusive OS lock whose crash releases ownership. Node has
 * no cross-platform `flock`, so this uses the portable equivalent:
 *
 * 1. `open(lockPath, 'wx')` is an atomic, exclusive create; only one process
 *    can win the create.
 * 2. The file body records the PID and process start time. A file left by a
 *    crash is recognised as stale because the PID is gone (or because the
 *    recorded start time no longer matches that PID, which covers PID reuse on
 *    Linux). The stale file is then removed and the create is retried.
 *
 * A live lock is never deleted, which is the property the v4 wrapper depends on
 * (§8.10 item 9). The two-process and stale-recovery tests exercise both sides.
 */
export function acquireLock(options: AcquireLockOptions): LockHandle {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? new Date();
  const procStartTicks =
    options.procStartTicks === undefined ? readProcStartTicks(pid) : options.procStartTicks;
  const info: LockFileInfo = {
    pid,
    startedAt: now.toISOString(),
    startTime: new Date(now.getTime() - process.uptime() * 1000).toISOString(),
    ...(procStartTicks === null ? {} : { procStartTicks }),
    app: "game-cat",
    version: APP_VERSION,
  };
  const body = `${JSON.stringify(info)}\n`;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(options.lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new StartupError(
          "DATA_DIR_NOT_WRITABLE",
          `Cannot create the lock file at ${options.lockPath}: ${(error as Error).message}`,
          { cause: error },
        );
      }

      const existingText = readText(options.lockPath);
      const existing = parseLockFile(existingText);
      if (existing !== null && isLockHeld(existing)) {
        throw new StartupError(
          "ALREADY_RUNNING",
          `Another game-cat process (PID ${existing.pid}) is already using ${options.dataDir}.`,
          {
            details: {
              pid: existing.pid,
              dataDir: options.dataDir,
              startedAt: existing.startedAt,
              lockPath: options.lockPath,
            },
          },
        );
      }

      // Stale (or unreadable). Re-read before unlinking so a lock that appeared
      // between the check and the unlink is not destroyed.
      if (readText(options.lockPath) !== existingText) {
        continue;
      }
      try {
        unlinkSync(options.lockPath);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new StartupError(
            "DATA_DIR_NOT_WRITABLE",
            `Cannot replace the stale lock file at ${options.lockPath}: ` +
              `${(unlinkError as Error).message}`,
            { cause: unlinkError },
          );
        }
      }
      continue;
    }

    try {
      writeSync(fd, body);
    } catch (error) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
      throw new StartupError(
        "DATA_DIR_NOT_WRITABLE",
        `Cannot write the lock file at ${options.lockPath}: ${(error as Error).message}`,
        { cause: error },
      );
    } finally {
      try {
        closeSync(fd);
      } catch {
        // already closed by the error path
      }
    }

    if (process.platform !== "win32") {
      try {
        // The open mode is subject to umask; make the documented mode explicit.
        chmodSync(options.lockPath, 0o600);
      } catch {
        // The lock is already exclusive; permissions are diagnostic hardening.
      }
    }

    let released = false;
    return {
      path: options.lockPath,
      info,
      release() {
        if (released) {
          return;
        }
        released = true;
        try {
          unlinkSync(options.lockPath);
        } catch {
          // ENOENT means someone already cleaned it; nothing else is safe to do.
        }
      },
    };
  }

  throw new StartupError(
    "ALREADY_RUNNING",
    `Could not acquire the lock at ${options.lockPath} after several attempts.`,
    { details: { dataDir: options.dataDir, lockPath: options.lockPath } },
  );
}

export function readLockFile(path: string): LockFileInfo | null {
  return parseLockFile(readText(path));
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function parseLockFile(text: string | null): LockFileInfo | null {
  if (text === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Partial<LockFileInfo>;
    if (
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.startedAt !== "string"
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      startTime: typeof parsed.startTime === "string" ? parsed.startTime : parsed.startedAt,
      ...(typeof parsed.procStartTicks === "string"
        ? { procStartTicks: parsed.procStartTicks }
        : {}),
      app: typeof parsed.app === "string" ? parsed.app : "game-cat",
      version: typeof parsed.version === "string" ? parsed.version : "unknown",
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isLockHeld(info: LockFileInfo): boolean {
  if (!isProcessAlive(info.pid)) {
    return false;
  }
  const currentTicks = readProcStartTicks(info.pid);
  if (
    info.procStartTicks !== undefined &&
    currentTicks !== null &&
    info.procStartTicks !== currentTicks
  ) {
    // The PID has been reused by a different process: the original holder is
    // gone, so the lock is stale.
    return false;
  }
  return true;
}

/** Linux-only PID start time (field 22 of /proc/<pid>/stat). */
function readProcStartTicks(pid: number): string | null {
  if (process.platform !== "linux") {
    return null;
  }
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closing = text.lastIndexOf(")");
    if (closing < 0) {
      return null;
    }
    // After the command name, fields resume at field 3 (state). starttime is
    // field 22, so it is index 19 in this slice.
    const fields = text
      .slice(closing + 1)
      .trim()
      .split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}
