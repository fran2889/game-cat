/**
 * Startup failures carry the string code from spec §8.5. The code is the
 * contract consumed by the CLI and the v4 wrapper; the numeric exit code is
 * deliberately coarse (1 for runtime failures, 2 for CLI usage).
 */
export type StartupCode =
  | "NODE_VERSION"
  | "CONFIG_INVALID"
  | "CONFIG_PERMISSIONS"
  | "DATA_DIR_NOT_WRITABLE"
  | "DATA_DIR_IN_STEAM"
  | "ALREADY_RUNNING"
  | "DB_UNRECOGNIZED"
  | "DB_SCHEMA_TOO_NEW"
  | "DB_MIGRATION_FAILED"
  | "DB_ACCOUNT_MISMATCH"
  | "PORT_IN_USE"
  | "INTERNAL_STARTUP";

export class StartupError extends Error {
  readonly code: StartupCode;
  readonly exitCode: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: StartupCode,
    message: string,
    options: { details?: Record<string, unknown>; cause?: unknown; exitCode?: number } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "StartupError";
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
    this.details = options.details;
  }
}

/** A malformed command line. Exits 2 before any startup work, per §8.5. */
export class CliUsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function isStartupError(error: unknown): error is StartupError {
  return error instanceof StartupError;
}

/**
 * A request-boundary rejection. `code` is the public ErrorDetail code, not a
 * startup code, and the message is safe to return to the client.
 */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options: { details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
  }
}
