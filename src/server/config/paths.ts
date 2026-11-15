import { homedir as osHomedir } from "node:os";
import { isAbsolute, join, resolve as resolvePathOnDisk, sep, win32 as pathWin32 } from "node:path";

/**
 * OS-standard per-user data directory, per spec §8.3 "Location".
 * Platform and environment are injectable so the rules are testable on any host.
 */
export function defaultDataDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string = osHomedir(),
): string {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    const base =
      localAppData !== undefined && localAppData !== ""
        ? localAppData
        : pathWin32.join(home, "AppData", "Local");
    return pathWin32.join(base, "game-cat");
  }

  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "game-cat");
  }

  const xdg = env.XDG_DATA_HOME?.trim();
  const base = xdg !== undefined && xdg !== "" ? xdg : join(home, ".local", "share");
  return join(base, "game-cat");
}

/** Expand a leading `~` using the injected home directory. */
export function expandHome(value: string, home: string): string {
  if (value === "~") {
    return home;
  }
  if (value.startsWith(`~${sep}`) || value.startsWith("~/")) {
    return join(home, value.slice(2));
  }
  if (value.startsWith("~\\")) {
    return pathWin32.join(home, value.slice(2));
  }
  return value;
}

/** Resolve a user-supplied path to an absolute path against the working directory. */
export function resolveUserPath(value: string, home: string, cwd: string): string {
  return resolvePathOnDisk(cwd, expandHome(value, home));
}

/** True when `child` is `parent` or lives inside it. Both must be absolute. */
export function isInside(parent: string, child: string): boolean {
  const resolvedParent = resolvePathOnDisk(parent);
  const resolvedChild = resolvePathOnDisk(child);
  if (resolvedChild === resolvedParent) {
    return true;
  }
  const parentWithSep = resolvedParent.endsWith(sep) ? resolvedParent : `${resolvedParent}${sep}`;
  return resolvedChild.startsWith(parentWithSep);
}

export function isAbsolutePath(value: string): boolean {
  return isAbsolute(value) || pathWin32.isAbsolute(value);
}
