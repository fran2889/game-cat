import type { Rule } from "../shared/rules.ts";

/**
 * Editor autosave state machine (§7.4).
 *
 * The controller owns the debounce, the single in-flight save, the coalescing
 * of edits made during a save, and the 2 s / 5 s / 15 s retry schedule. It has
 * no React or fetch dependency, so the timing rules are tested with fake
 * timers without a browser.
 */

export interface AutosaveSnapshot {
  name: string;
  rules: Rule[];
}

export type AutosaveStatus = "idle" | "saved" | "unsaved" | "saving" | "failed";

export interface AutosaveState {
  status: AutosaveStatus;
  dirty: boolean;
  /** A retry is scheduled and the controller is waiting for its delay. */
  retrying: boolean;
  /** The delay of the scheduled retry, or `null` when none is scheduled. */
  retryDelay: number | null;
  /** The number of automatic retries already scheduled for this failure run. */
  retryAttempt: number;
  lastError: unknown | null;
  /** A manual Retry can help; false for a 409 conflict or a 422 validation error. */
  canRetry: boolean;
}

export interface AutosaveOptions {
  /** Persist one snapshot. Reject to enter the failure path. */
  save(snapshot: AutosaveSnapshot): Promise<AutosaveSnapshot>;
  /** Defaults to retrying every error except 409 conflicts and 422 validation. */
  isRetryable?(error: unknown): boolean;
  onChange?(state: AutosaveState): void;
  onSaved?(snapshot: AutosaveSnapshot): void;
  onError?(error: unknown, final: boolean): void;
  debounceMs?: number;
  retryDelays?: readonly number[];
}

export const AUTOSAVE_DEBOUNCE_MS = 600;
export const AUTOSAVE_RETRY_DELAYS = [2_000, 5_000, 15_000] as const;

function cloneRule(rule: Rule): Rule {
  return {
    ...rule,
    value: Array.isArray(rule.value) ? [...rule.value] : rule.value,
  };
}

function cloneSnapshot(snapshot: AutosaveSnapshot): AutosaveSnapshot {
  return {
    name: snapshot.name,
    rules: snapshot.rules.map(cloneRule),
  };
}

/** Stable comparison that matches the server's trim and NFC-normalized name. */
function serializeSnapshot(snapshot: AutosaveSnapshot): string {
  return JSON.stringify({
    name: snapshot.name.trim().normalize("NFC"),
    rules: snapshot.rules.map((rule) => [rule.prefix, rule.field, rule.operator, rule.value]),
  });
}

export class AutosaveController {
  private readonly debounceMs: number;
  private readonly retryDelays: readonly number[];
  private readonly options: AutosaveOptions;

  private saved: AutosaveSnapshot | null = null;
  /**
   * The draft the editor started from before the first save. Saved Collections
   * compare against `saved`; a `/smart/new` draft compares against this so the
   * leave guard can see edits without duplicating the snapshot comparison.
   */
  private initial: AutosaveSnapshot | null = null;
  private draft: AutosaveSnapshot = { name: "", rules: [] };
  private valid = true;
  private status: AutosaveStatus = "idle";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving = false;
  private retrying = false;
  private retryDelay: number | null = null;
  private retryIndex = 0;
  private lastError: unknown | null = null;
  private disposed = false;

  constructor(options: AutosaveOptions) {
    this.options = options;
    this.debounceMs = options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
    this.retryDelays = options.retryDelays ?? AUTOSAVE_RETRY_DELAYS;
  }

  /**
   * Seed the editor with its last successful save, or `null` for `/smart/new`.
   * A new draft may pass the draft it starts from so `dirty` reports edits
   * made before the first explicit save.
   */
  reset(snapshot: AutosaveSnapshot | null, initialDraft?: AutosaveSnapshot): void {
    this.clearTimer();
    this.disposed = false;
    this.saving = false;
    this.retrying = false;
    this.retryDelay = null;
    this.retryIndex = 0;
    this.lastError = null;
    this.saved = snapshot === null ? null : cloneSnapshot(snapshot);
    this.initial =
      snapshot === null && initialDraft !== undefined ? cloneSnapshot(initialDraft) : null;
    this.draft = cloneSnapshot(snapshot ?? initialDraft ?? { name: "", rules: [] });
    this.valid = true;
    this.status = snapshot === null ? "idle" : "saved";
    this.emit();
  }

  /** Mark a successful explicit create as the new baseline. */
  markSaved(snapshot: AutosaveSnapshot): void {
    this.clearTimer();
    this.saving = false;
    this.retrying = false;
    this.retryDelay = null;
    this.retryIndex = 0;
    this.lastError = null;
    this.saved = cloneSnapshot(snapshot);
    this.initial = null;
    this.status = this.isDirty() ? "unsaved" : "saved";
    this.emit();
  }

  updateDraft(draft: AutosaveSnapshot, valid: boolean): void {
    const changed =
      serializeSnapshot(draft) !== serializeSnapshot(this.draft) || valid !== this.valid;
    this.draft = cloneSnapshot(draft);
    this.valid = valid;
    if (!changed) {
      return;
    }

    if (this.saved === null) {
      // No autosave before the first explicit save.
      this.clearTimer();
      this.retrying = false;
      this.retryDelay = null;
      this.retryIndex = 0;
      this.lastError = null;
      this.status = "idle";
      this.emit();
      return;
    }

    this.clearTimer();
    this.retrying = false;
    this.retryDelay = null;
    this.retryIndex = 0;
    this.lastError = null;

    if (!this.isDirty()) {
      this.status = "saved";
      this.emit();
      return;
    }

    if (this.saving) {
      this.status = "saving";
      this.emit();
      return;
    }

    this.status = "unsaved";
    if (!valid) {
      this.emit();
      return;
    }
    this.emit();
    this.schedule(this.debounceMs, () => {
      void this.attempt();
    });
  }

  /** Ctrl/Cmd+S: skip the debounce and save now when the draft is valid. */
  saveNow(): void {
    if (this.saved === null || !this.valid || this.saving) {
      return;
    }
    this.clearTimer();
    this.retrying = false;
    this.retryDelay = null;
    this.retryIndex = 0;
    this.lastError = null;
    if (!this.isDirty()) {
      this.status = "saved";
      this.emit();
      return;
    }
    void this.attempt();
  }

  /** Retry after a failed save without waiting for the next scheduled delay. */
  retryNow(): void {
    if (this.saved === null || !this.valid || this.saving) {
      return;
    }
    this.clearTimer();
    this.retrying = false;
    this.retryDelay = null;
    this.retryIndex = 0;
    this.lastError = null;
    void this.attempt();
  }

  /** Revert the draft to the last successful save; no undo of a real save. */
  discard(): AutosaveSnapshot | null {
    if (this.saved === null || this.saving) {
      return null;
    }
    this.clearTimer();
    this.retrying = false;
    this.retryDelay = null;
    this.retryIndex = 0;
    this.lastError = null;
    this.draft = cloneSnapshot(this.saved);
    this.status = "saved";
    this.emit();
    return cloneSnapshot(this.saved);
  }

  /** Stop pending timers, used before a delete or on unmount. */
  cancelPending(): void {
    this.clearTimer();
    this.retrying = false;
    this.retryDelay = null;
    this.emit();
  }

  /** Resume the debounce after a cancelled delete attempt. */
  reschedule(): void {
    if (this.saved === null || this.saving || !this.valid || !this.isDirty()) {
      return;
    }
    this.clearTimer();
    this.status = "unsaved";
    this.emit();
    this.schedule(this.debounceMs, () => {
      void this.attempt();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  getState(): AutosaveState {
    return {
      status: this.status,
      dirty: this.isDirty(),
      retrying: this.retrying,
      retryDelay: this.retryDelay,
      retryAttempt: this.retryIndex,
      lastError: this.lastError,
      canRetry: this.saved !== null && this.lastError !== null && this.isRetryable(this.lastError),
    };
  }

  private isDirty(): boolean {
    const baseline = this.saved ?? this.initial;
    return baseline !== null && serializeSnapshot(this.draft) !== serializeSnapshot(baseline);
  }

  private isRetryable(error: unknown): boolean {
    return this.options.isRetryable?.(error) ?? true;
  }

  private async attempt(): Promise<void> {
    if (this.disposed || this.saving || this.saved === null) {
      return;
    }
    if (!this.valid) {
      this.status = "unsaved";
      this.emit();
      return;
    }
    if (!this.isDirty()) {
      this.status = "saved";
      this.emit();
      return;
    }

    this.saving = true;
    this.retrying = false;
    this.retryDelay = null;
    this.status = "saving";
    this.emit();

    const snapshot: AutosaveSnapshot = {
      name: this.draft.name.trim(),
      rules: this.draft.rules.map(cloneRule),
    };

    try {
      const saved = await this.options.save(snapshot);
      if (this.disposed) {
        return;
      }
      this.saving = false;
      this.saved = cloneSnapshot(saved);
      this.lastError = null;
      this.retryIndex = 0;
      this.retrying = false;
      this.retryDelay = null;
      this.status = this.isDirty() ? "unsaved" : "saved";
      this.options.onSaved?.(cloneSnapshot(saved));
      this.emit();
      if (this.status === "unsaved" && this.valid) {
        // Edits made during this save coalesce into a save that starts now.
        await this.attempt();
      }
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.saving = false;
      this.lastError = error;

      if (!this.isRetryable(error)) {
        this.retrying = false;
        this.retryDelay = null;
        this.status = "failed";
        this.options.onError?.(error, true);
        this.emit();
        return;
      }

      if (this.retryIndex < this.retryDelays.length) {
        const delay = this.retryDelays[this.retryIndex]!;
        this.retryIndex += 1;
        this.retrying = true;
        this.retryDelay = delay;
        this.status = "failed";
        this.options.onError?.(error, false);
        this.emit();
        this.schedule(delay, () => {
          this.retrying = false;
          this.retryDelay = null;
          void this.attempt();
        });
        return;
      }

      this.retrying = false;
      this.retryDelay = null;
      this.status = "failed";
      this.options.onError?.(error, true);
      this.emit();
    }
  }

  private schedule(delay: number, callback: () => void): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      callback();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private emit(): void {
    this.options.onChange?.(this.getState());
  }
}
