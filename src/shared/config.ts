import type { LogLevel } from "./types.ts";

/**
 * The editable settings accepted by `PATCH /api/config`. This list is the one
 * runtime source for the field set: the request schema and the store both
 * derive from it, so a new field cannot be added to only one side.
 */
export const CONFIG_PATCH_FIELDS = [
  "steamApiKey",
  "steamRoot",
  "steamId64",
  "port",
  "openBrowser",
  "logLevel",
] as const;

export type ConfigPatchField = (typeof CONFIG_PATCH_FIELDS)[number];

/** The wire shape of `PATCH /api/config`; every field is optional. */
export interface ConfigPatch {
  steamApiKey?: string;
  steamRoot?: string;
  steamId64?: string;
  port?: number;
  openBrowser?: boolean;
  logLevel?: LogLevel;
}
