import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";
import pino, { type Logger, type StreamEntry } from "pino";
import pinoPretty from "pino-pretty";
import type { LogLevel } from "../../shared/types.ts";
import { RotatingFileStream } from "./rotate.ts";

export interface LoggerOptions {
  level: LogLevel;
  /** Absolute path to the JSONL log file. `null` disables file logging. */
  filePath?: string | null;
  /** Write to stderr (human-readable on a TTY, JSON otherwise). Default true. */
  stderr?: boolean;
  /** Additional, always-JSON sink for the v4 wrapper or tests. */
  stream?: Writable;
  /** Test seam for the stderr destination. Defaults to fd 2. */
  stderrStream?: Writable;
  /** Force human-readable stderr output. Defaults to process.stderr.isTTY. */
  tty?: boolean;
  maxFileSizeBytes?: number;
  keepFiles?: number;
}

export interface AppLogger {
  logger: Logger;
  filePath: string | null;
  /** Non-null when the log file could not be opened; logging continued on the other sinks. */
  fileError: string | null;
  close(): Promise<void>;
}

export const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_FILE_KEEP = 3;

export function defaultLogPath(dataDir: string): string {
  return join(dataDir, "logs", "game-cat.log");
}

/** Strip a query string, and optionally keep it with `key` parameters redacted. */
export function redactUrl(url: string, options: { keepQuery?: boolean } = {}): string {
  const queryIndex = url.indexOf("?");
  if (queryIndex < 0) {
    return url;
  }
  const path = url.slice(0, queryIndex);
  if (options.keepQuery !== true) {
    return path;
  }
  const query = url
    .slice(queryIndex + 1)
    .replace(/(^|&)(key|apiKey|api_key)=[^&]*/gi, "$1$2=[REDACTED]");
  return `${path}?${query}`;
}

const REDACT_PATHS = [
  "steamApiKey",
  "*.steamApiKey",
  "*.*.steamApiKey",
  "apiKey",
  "*.apiKey",
  "key",
  "*.key",
  "*.*.key",
  "accountName",
  "*.accountName",
  "*.*.accountName",
  "AccountName",
  "*.AccountName",
  "headers.authorization",
  "headers.cookie",
  "req.headers.authorization",
  "req.headers.cookie",
];

/**
 * Pino logger with the §8.8 sinks: stderr (pretty on a TTY, JSON otherwise) and
 * always-JSONL `<data-dir>/logs/game-cat.log`. The key and AccountName are
 * redacted at the logger, not only at call sites.
 */
export function createLogger(options: LoggerOptions): AppLogger {
  const level = options.level;
  const tty = options.tty ?? process.stderr.isTTY === true;
  const useStderr = options.stderr ?? true;
  const streams: StreamEntry[] = [];
  let fileStream: RotatingFileStream | null = null;
  let fileError: string | null = null;
  const filePath = options.filePath ?? null;

  // The logger's own level is the single filter, so changing it at runtime
  // through the settings API applies immediately to every sink. Giving each
  // stream the startup level would pin that level for the process lifetime.
  const streamLevel = "trace";

  if (useStderr) {
    if (tty) {
      streams.push({
        level: streamLevel,
        stream: pinoPretty({
          destination: options.stderrStream ?? 2,
          colorize: false,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        }),
      });
    } else if (options.stderrStream !== undefined) {
      streams.push({ level: streamLevel, stream: options.stderrStream });
    } else {
      streams.push({ level: streamLevel, stream: pino.destination({ dest: 2, sync: true }) });
    }
  }
  // The injectable sink is always JSON lines, even when stderr is a TTY, so a
  // wrapper can parse it without stripping pino-pretty formatting.
  if (options.stream !== undefined) {
    streams.push({ level: streamLevel, stream: options.stream });
  }

  if (filePath !== null) {
    try {
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      fileStream = new RotatingFileStream({
        filePath,
        maxSizeBytes: options.maxFileSizeBytes ?? LOG_FILE_MAX_BYTES,
        keepFiles: options.keepFiles ?? LOG_FILE_KEEP,
      });
      streams.push({ level: streamLevel, stream: fileStream });
    } catch (error) {
      fileError = (error as Error).message;
    }
  }

  const logger =
    streams.length === 0
      ? pino({ level: "silent" })
      : pino(
          {
            level,
            base: { app: "game-cat", pid: process.pid },
            timestamp: pino.stdTimeFunctions.isoTime,
            redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
          },
          pino.multistream(streams, { dedupe: false }),
        );

  return {
    logger,
    filePath: fileStream === null ? null : filePath,
    fileError,
    async close() {
      if (fileStream === null) {
        return;
      }
      const stream = fileStream;
      fileStream = null;
      await new Promise<void>((resolve) => {
        stream.end(() => resolve());
      });
    },
  };
}
