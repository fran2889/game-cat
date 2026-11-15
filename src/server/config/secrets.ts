import type { FileConfig } from "./load.ts";
import { writeConfigAtomically } from "./write.ts";

/**
 * The Steam Web API key boundary required by spec §8.10 item 8.
 *
 * Refresh reads the key through this interface and the API never returns it.
 * v1 ships the `config.json` implementation; the v4 wrapper may replace it with
 * the OS keychain by passing another store to `createServer`.
 */
export interface SecretStore {
  /**
   * Diagnostic identity only. `config-file` means the bundled store owns the
   * key in `config.json`; `external` means the file must not contain it.
   */
  readonly storage: "config-file" | "external";
  /** The stored key, or `null`. Never log or return this over HTTP. */
  read(): string | null;
  /** Persist a new key. Throws when the store cannot write. */
  write(key: string): void;
}

export interface ConfigFileSecretStoreOptions {
  configPath: string;
  platform?: NodeJS.Platform;
  /** The current config document. The store reads the key from it. */
  readDocument: () => FileConfig;
  /** Called after a successful atomic write with the committed document. */
  commitDocument: (document: FileConfig) => void;
}

/**
 * v1's secret store: the key is one field of the atomically written, 0600
 * `<data-dir>/config.json`. Other settings stay in the same document.
 */
export function createConfigFileSecretStore(options: ConfigFileSecretStoreOptions): SecretStore {
  return {
    storage: "config-file",
    read() {
      return options.readDocument().steamApiKey ?? null;
    },
    write(key: string) {
      const next: FileConfig = { ...options.readDocument(), steamApiKey: key };
      writeConfigAtomically(options.configPath, next, options.platform ?? process.platform);
      options.commitDocument(next);
    },
  };
}
