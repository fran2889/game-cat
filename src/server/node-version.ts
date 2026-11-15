import { MIN_NODE_MAJOR } from "../shared/app.ts";
import { StartupError } from "./errors.ts";

/**
 * Refuse to start below the supported Node major. The version is injectable so
 * tests can prove the refusal without installing an older Node.
 *
 * This runs before configuration, the data directory, the lock, or any database
 * work, per spec §8.5 step 1.
 */
export function assertNodeVersion(version: string = process.versions.node): void {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  const major = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10);

  if (!Number.isInteger(major) || major < MIN_NODE_MAJOR) {
    throw new StartupError(
      "NODE_VERSION",
      `game-cat requires Node ${MIN_NODE_MAJOR} or newer; found ${version}. ` +
        `Install Node ${MIN_NODE_MAJOR}+ and try again.`,
      { details: { found: version, required: `>=${MIN_NODE_MAJOR}` } },
    );
  }
}
