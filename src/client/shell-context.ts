import type { Config, Status } from "../shared/types.ts";

export interface ShellContext {
  status: Status | null;
  config: Config | null;
  error: string | null;
  reloadStatus(): void;
  reloadConfig(): void;
  applyConfig(config: Config): void;
}
