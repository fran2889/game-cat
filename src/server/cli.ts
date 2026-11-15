#!/usr/bin/env node
import { APP_VERSION, DB_SCHEMA_VERSION } from "../shared/app.ts";
import { parseCliArgs, USAGE } from "./cli-args.ts";
import { CliUsageError, isStartupError } from "./errors.ts";
import { startServer } from "./index.ts";

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(`game-cat: ${error.message}`);
      console.error(USAGE);
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }

  if (parsed.help) {
    console.log(USAGE);
    return;
  }
  if (parsed.version) {
    console.log(`game-cat ${APP_VERSION} (database schema ${DB_SCHEMA_VERSION})`);
    return;
  }

  try {
    const running = await startServer(parsed.options);
    // The readiness line is the human signal from §8.5; the programmatic API
    // returns the same URL without scraping stdout.
    console.log(`game-cat ${APP_VERSION} is listening at ${running.url}`);
  } catch (error) {
    if (isStartupError(error)) {
      console.error(`game-cat: ${error.code}: ${error.message}`);
      process.exitCode = error.exitCode;
      return;
    }
    console.error(`game-cat: INTERNAL_STARTUP: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

await main();
