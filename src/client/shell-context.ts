import type { Status } from "../shared/types.ts";

export interface ShellContext {
  status: Status | null;
  error: string | null;
  reloadStatus(): void;
}
