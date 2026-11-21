import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AutosaveController,
  type AutosaveSnapshot,
  type AutosaveState,
} from "../../src/client/autosave.ts";
import type { Rule } from "../../src/shared/rules.ts";

function snapshot(name: string, rules: Rule[] = []): AutosaveSnapshot {
  return { name, rules };
}

const ALPHA = snapshot("Alpha");
const BETA = snapshot("Beta");
const GAMMA = snapshot("Gamma");
const DELTA = snapshot("Delta");

function controllerFor(
  save: (snapshot: AutosaveSnapshot) => Promise<AutosaveSnapshot>,
  options: {
    isRetryable?(error: unknown): boolean;
    states?: AutosaveState[];
  } = {},
): AutosaveController {
  return new AutosaveController({
    save,
    isRetryable: options.isRetryable,
    onChange: (state) => options.states?.push(state),
  });
}

describe("Smart Collection autosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not autosave before the first explicit save", async () => {
    const save = vi.fn(async (draft: AutosaveSnapshot) => draft);
    const controller = controllerFor(save);
    controller.reset(null);

    controller.updateDraft(BETA, true);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(save).not.toHaveBeenCalled();
    expect(controller.getState().status).toBe("idle");
  });

  it("reports edits to a new draft as dirty against its initial draft", () => {
    const save = vi.fn(async (draft: AutosaveSnapshot) => draft);
    const controller = controllerFor(save);
    controller.reset(null, ALPHA);
    expect(controller.getState()).toMatchObject({ status: "idle", dirty: false });

    controller.updateDraft(BETA, true);
    expect(controller.getState()).toMatchObject({ status: "idle", dirty: true });

    controller.updateDraft(ALPHA, true);
    expect(controller.getState()).toMatchObject({ status: "idle", dirty: false });
    expect(save).not.toHaveBeenCalled();
  });

  it("debounces name and Rule edits 600 ms after the last change", async () => {
    const save = vi.fn(async (draft: AutosaveSnapshot) => draft);
    const controller = controllerFor(save);
    controller.reset(ALPHA);

    controller.updateDraft(BETA, true);
    await vi.advanceTimersByTimeAsync(599);
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toEqual(snapshot("Beta"));
    expect(controller.getState().status).toBe("saved");
  });

  it("coalesces edits during the debounce into one save with the latest draft", async () => {
    const save = vi.fn(async (draft: AutosaveSnapshot) => draft);
    const controller = controllerFor(save);
    controller.reset(ALPHA);

    controller.updateDraft(BETA, true);
    await vi.advanceTimersByTimeAsync(300);
    controller.updateDraft(GAMMA, true);
    await vi.advanceTimersByTimeAsync(300);
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0].name).toBe("Gamma");
  });

  it("keeps one save in flight and starts the coalesced save when it finishes", async () => {
    const pending: Array<() => void> = [];
    const save = vi.fn(
      (draft: AutosaveSnapshot) =>
        new Promise<AutosaveSnapshot>((resolve) => {
          pending.push(() => resolve(draft));
        }),
    );
    const controller = controllerFor(save);
    controller.reset(ALPHA);

    controller.updateDraft(BETA, true);
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(1);
    expect(controller.getState().status).toBe("saving");

    controller.updateDraft(GAMMA, true);
    controller.updateDraft(DELTA, true);
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(1);
    expect(controller.getState().status).toBe("saving");

    pending[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![0].name).toBe("Delta");

    pending[1]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getState().status).toBe("saved");
  });

  it("does not autosave an invalid name or invalid Rule", async () => {
    const save = vi.fn(async (draft: AutosaveSnapshot) => draft);
    const controller = controllerFor(save);
    controller.reset(ALPHA);

    controller.updateDraft(BETA, false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(save).not.toHaveBeenCalled();
    expect(controller.getState().status).toBe("unsaved");

    controller.updateDraft(GAMMA, true);
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0].name).toBe("Gamma");
  });

  it("moves Saved → Unsaved changes → Saving… → Saved", async () => {
    const states: AutosaveState[] = [];
    const save = vi.fn(async (draft: AutosaveSnapshot) => draft);
    const controller = controllerFor(save, { states });
    controller.reset(ALPHA);

    controller.updateDraft(BETA, true);
    controller.saveNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(states.map((state) => state.status)).toEqual(["saved", "unsaved", "saving", "saved"]);
  });

  it("retries at 2 s, 5 s, and 15 s then offers a manual Retry", async () => {
    let calls = 0;
    const save = vi.fn(async (draft: AutosaveSnapshot) => {
      calls += 1;
      if (calls <= 4) {
        throw new Error("server unavailable");
      }
      return draft;
    });
    const controller = controllerFor(save);
    controller.reset(ALPHA);
    controller.updateDraft(BETA, true);

    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({
      status: "failed",
      retrying: true,
      retryDelay: 2_000,
      retryAttempt: 1,
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(2);
    expect(controller.getState()).toMatchObject({ retrying: true, retryDelay: 5_000 });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(save).toHaveBeenCalledTimes(3);
    expect(controller.getState()).toMatchObject({ retrying: true, retryDelay: 15_000 });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(save).toHaveBeenCalledTimes(4);
    expect(controller.getState()).toMatchObject({
      status: "failed",
      retrying: false,
      retryDelay: null,
      canRetry: true,
    });

    controller.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(5);
    expect(controller.getState().status).toBe("saved");
  });

  it("keeps local edits while retrying and restarts the debounce on a new edit", async () => {
    const save = vi.fn(async (draft: AutosaveSnapshot) => {
      if (save.mock.calls.length === 1) {
        throw new Error("server unavailable");
      }
      return draft;
    });
    const controller = controllerFor(save);
    controller.reset(ALPHA);

    controller.updateDraft(BETA, true);
    await vi.advanceTimersByTimeAsync(600);
    expect(controller.getState()).toMatchObject({ status: "failed", retrying: true });

    controller.updateDraft(GAMMA, true);
    expect(controller.getState()).toMatchObject({
      status: "unsaved",
      dirty: true,
      retrying: false,
    });

    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![0].name).toBe("Gamma");
    expect(controller.getState().status).toBe("saved");
  });

  it("does not retry a conflict or validation failure", async () => {
    const save = vi.fn(async () => {
      throw new Error("conflict");
    });
    const controller = controllerFor(save, { isRetryable: () => false });
    controller.reset(ALPHA);

    controller.updateDraft(BETA, true);
    await vi.advanceTimersByTimeAsync(600);
    expect(controller.getState()).toMatchObject({
      status: "failed",
      retrying: false,
      canRetry: false,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("Discard reverts to the last successful save without undoing that save", async () => {
    const save = vi.fn(async (draft: AutosaveSnapshot) => draft);
    const controller = controllerFor(save);
    controller.reset(ALPHA);

    controller.updateDraft(BETA, true);
    await vi.advanceTimersByTimeAsync(600);
    expect(controller.getState().status).toBe("saved");

    controller.updateDraft(GAMMA, true);
    expect(controller.getState().dirty).toBe(true);
    const reverted = controller.discard();

    expect(reverted).toEqual(snapshot("Beta"));
    expect(controller.getState()).toMatchObject({ status: "saved", dirty: false });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("Ctrl/Cmd+S saves immediately without waiting for the debounce", async () => {
    const save = vi.fn(async (draft: AutosaveSnapshot) => draft);
    const controller = controllerFor(save);
    controller.reset(ALPHA);

    controller.updateDraft(BETA, true);
    controller.saveNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0].name).toBe("Beta");
    expect(controller.getState().status).toBe("saved");
  });

  it("trims the name sent to the server but keeps the local draft", async () => {
    const save = vi.fn(async (draft: AutosaveSnapshot) => ({ ...draft, name: draft.name.trim() }));
    const controller = controllerFor(save);
    controller.reset(ALPHA);

    controller.updateDraft(snapshot("  Padded  "), true);
    await vi.advanceTimersByTimeAsync(600);

    expect(save.mock.calls[0]![0].name).toBe("Padded");
    expect(controller.getState().status).toBe("saved");
  });

  it("recognizes the server's NFC-normalized name as the same draft", async () => {
    const save = vi.fn(async (draft: AutosaveSnapshot) => ({
      ...draft,
      name: draft.name.normalize("NFC"),
    }));
    const controller = controllerFor(save);
    controller.reset(ALPHA);

    controller.updateDraft(snapshot("Cafe\u0301"), true);
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(1);
    expect(controller.getState().status).toBe("saved");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
