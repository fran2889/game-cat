import { Command, CommanderError } from "commander";
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

interface RawCliOptions {
  dataDir?: string;
  port?: string;
  open?: boolean;
  logLevel?: string;
  help?: boolean;
  version?: boolean;
}

/** Commander renders this; the flags and their descriptions are the contract. */
function createProgram(): Command {
  return (
    new Command()
      .name("game-cat")
      // `--help` and `--version` are ordinary options below so a structural
      // mistake is always a usage error, matching the frozen CLI surface.
      .helpOption(false)
      .allowExcessArguments(false)
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} })
      .addHelpText("before", "game-cat - a local, read-first view of a Steam library\n")
      .addHelpText(
        "after",
        "\nEnvironment:\n" +
          "  GAME_CAT_DATA_DIR, GAME_CAT_PORT, GAME_CAT_OPEN_BROWSER, GAME_CAT_LOG_LEVEL,\n" +
          "  GAME_CAT_STEAM_ROOT, GAME_CAT_STEAM_ID64, GAME_CAT_STEAM_API_KEY\n",
      )
      .option("--data-dir <path>", "Data directory (overrides GAME_CAT_DATA_DIR)")
      .option("--port <number>", "Loopback port, 0-65535; 0 asks the OS (default 4780)")
      .option("--no-open", "Do not open the browser")
      .option("--log-level <level>", "trace, debug, info, warn, error, or fatal (default info)")
      .option("--help, -h", "Show this help")
      .option("--version, -v", "Print the app version and bundled database schema version")
  );
}

/** The help text, rendered by commander from the option catalogue above. */
export const USAGE = renderHelp();

function renderHelp(): string {
  const program = createProgram();
  let text = "";
  program.configureOutput({
    writeOut: (chunk: string) => {
      text += chunk;
    },
    writeErr: () => {},
  });
  program.outputHelp();
  return text;
}

/**
 * Parse the CLI without touching the process. Value validation deliberately
 * happens in the config layer so an invalid value exits with `CONFIG_INVALID`,
 * while structural mistakes (unknown flag, missing value) exit 2.
 */
export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const program = createProgram();
  try {
    program.parse([...argv], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new CliUsageError(usageMessage(error, program));
    }
    throw error;
  }

  const raw = program.opts<RawCliOptions>();
  const options: CliOptions = {};
  if (raw.dataDir !== undefined) {
    options.dataDir = requireValue("--data-dir", raw.dataDir);
  }
  if (raw.port !== undefined) {
    options.port = requireValue("--port", raw.port);
  }
  if (raw.logLevel !== undefined) {
    options.logLevel = requireValue("--log-level", raw.logLevel);
  }
  // `--no-open` is commander's negatable option: it defaults to true, so only
  // an explicit flag may override the environment and config file.
  if (raw.open === false) {
    options.openBrowser = false;
  }

  return { help: raw.help === true, version: raw.version === true, options };
}

function requireValue(flag: string, value: string): string {
  if (value === "") {
    throw new CliUsageError(`Option ${flag} requires a value`);
  }
  return value;
}

function usageMessage(error: CommanderError, program: Command): string {
  switch (error.code) {
    case "commander.unknownOption": {
      const option = /unknown option '([^']+)'/.exec(error.message)?.[1];
      return option === undefined ? "Unknown option" : `Unknown option: ${option}`;
    }
    case "commander.optionMissingArgument": {
      const option = /option '([^' <]+)/.exec(error.message)?.[1];
      return option === undefined
        ? "An option requires a value"
        : `Option ${option} requires a value`;
    }
    case "commander.excessArguments": {
      const argument = program.args[0];
      return argument === undefined ? "Unexpected argument" : `Unexpected argument: ${argument}`;
    }
    default:
      return error.message.replace(/^error: /, "");
  }
}
