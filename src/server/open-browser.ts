import { spawn } from "node:child_process";
import type { Logger } from "pino";

export interface OpenBrowserOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

export interface OpenBrowserResult {
  opened: boolean;
  reason?: "disabled" | "headless" | "failed";
}

/**
 * Best-effort browser opening (§8.3, §8.5 step 11). A failure is logged at warn
 * and never fails startup. Headless Linux environments are skipped so the CLI
 * is usable over SSH and in CI.
 */
export function openBrowserBestEffort(
  url: string,
  options: OpenBrowserOptions = {},
): OpenBrowserResult {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (
    platform === "linux" &&
    (env.DISPLAY === undefined || env.DISPLAY === "") &&
    (env.WAYLAND_DISPLAY === undefined || env.WAYLAND_DISPLAY === "")
  ) {
    return { opened: false, reason: "headless" };
  }

  const [command, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];

  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", (error) => {
      options.logger?.warn({ err: error }, "could not open the browser");
    });
    child.unref();
    return { opened: true };
  } catch (error) {
    options.logger?.warn({ err: error }, "could not open the browser");
    return { opened: false, reason: "failed" };
  }
}
