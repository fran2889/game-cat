import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { Writable } from "node:stream";

export interface RotatingFileStreamOptions {
  filePath: string;
  maxSizeBytes: number;
  keepFiles: number;
  mode?: number;
}

/**
 * A small in-process rotating JSONL sink. Rotation happens before a write that
 * would exceed the limit, so lines are never split across files. The three
 * documented files are `game-cat.log`, `.1`, and `.2`.
 */
export class RotatingFileStream extends Writable {
  readonly filePath: string;
  readonly maxSizeBytes: number;
  readonly keepFiles: number;

  private fd: number | null;
  private size = 0;
  private writeError: Error | null = null;

  constructor(options: RotatingFileStreamOptions) {
    super();
    this.filePath = options.filePath;
    this.maxSizeBytes = options.maxSizeBytes;
    this.keepFiles = Math.max(1, options.keepFiles);
    this.fd = openSync(this.filePath, "a", options.mode ?? 0o600);
    this.size = statSync(this.filePath).size;
    if (process.platform !== "win32") {
      try {
        chmodSync(this.filePath, options.mode ?? 0o600);
      } catch {
        // Non-fatal; the parent directory is 0700.
      }
    }
  }

  currentSize(): number {
    return this.size;
  }

  lastWriteError(): Error | null {
    return this.writeError;
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    try {
      if (this.fd === null) {
        callback();
        return;
      }
      if (this.size > 0 && this.size + buffer.length > this.maxSizeBytes) {
        this.rotate();
      }
      if (this.fd !== null) {
        writeSync(this.fd, buffer);
        this.size += buffer.length;
      }
      this.writeError = null;
      callback();
    } catch (error) {
      // Logging is diagnostic and must never take the process down.
      this.writeError = error as Error;
      callback();
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.closeFile();
    callback();
  }

  private rotate(): void {
    this.closeFile();

    const oldest = `${this.filePath}.${this.keepFiles - 1}`;
    if (existsSync(oldest)) {
      unlinkSync(oldest);
    }
    for (let index = this.keepFiles - 2; index >= 1; index -= 1) {
      const source = `${this.filePath}.${index}`;
      if (existsSync(source)) {
        renameSync(source, `${this.filePath}.${index + 1}`);
      }
    }
    if (existsSync(this.filePath)) {
      renameSync(this.filePath, `${this.filePath}.1`);
    }

    this.fd = openSync(this.filePath, "w", 0o600);
    this.size = 0;
  }

  private closeFile(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // already closed
      }
      this.fd = null;
    }
  }
}
