import { CliUsageError } from "./errors.ts";

export interface CliOptions {
  dataDir?: string;
  port?: string;
  openBrowser?: boolean;
  logLevel?: string;
}

export interface ParsedCliArgs {
  help: boolean;
  version: boolean;
  options: CliOptions;
}

export const USAGE = `game-cat - a local, read-first view of a Steam library

Usage: game-cat [options]

Options:
  --data-dir <path>   Data directory (overrides GAME_CAT_DATA_DIR)
  --port <number>     Loopback port, 0-65535; 0 asks the OS (default 4780)
  --no-open           Do not open the browser
  --log-level <level> trace, debug, info, warn, error, or fatal (default info)
  --help, -h          Show this help
  --version, -v       Print the app version and bundled database schema version

Environment:
  GAME_CAT_DATA_DIR, GAME_CAT_PORT, GAME_CAT_OPEN_BROWSER, GAME_CAT_LOG_LEVEL,
  GAME_CAT_STEAM_ROOT, GAME_CAT_STEAM_ID64, GAME_CAT_STEAM_API_KEY
`;

const VALUE_FLAGS = new Set(["--data-dir", "--port", "--log-level"]);

/**
 * Parse the CLI without touching the process. Value validation deliberately
 * happens in the config layer so an invalid value exits with `CONFIG_INVALID`,
 * while structural mistakes (unknown flag, missing value) exit 2.
 */
export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const parsed: ParsedCliArgs = { help: false, version: false, options: {} };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }

    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    if (argument === "--version" || argument === "-v") {
      parsed.version = true;
      continue;
    }
    if (argument === "--no-open") {
      parsed.options.openBrowser = false;
      continue;
    }

    const equals = argument.indexOf("=");
    const flag = equals < 0 ? argument : argument.slice(0, equals);
    if (!VALUE_FLAGS.has(flag)) {
      throw new CliUsageError(
        argument.startsWith("-")
          ? `Unknown option: ${argument}`
          : `Unexpected argument: ${argument}`,
      );
    }

    let value: string | undefined;
    if (equals >= 0) {
      value = argument.slice(equals + 1);
    } else {
      index += 1;
      value = argv[index];
    }
    if (value === undefined || value === "") {
      throw new CliUsageError(`Option ${flag} requires a value`);
    }

    if (flag === "--data-dir") {
      parsed.options.dataDir = value;
    } else if (flag === "--port") {
      parsed.options.port = value;
    } else {
      parsed.options.logLevel = value;
    }
  }

  return parsed;
}
