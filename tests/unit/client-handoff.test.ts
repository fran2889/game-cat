import { describe, expect, it } from "vitest";
import { handoffFromSelection, readDraftHandoff } from "../../src/client/smart-handoff.ts";

describe("New from selection handoff", () => {
  it("creates one AND game rule with ascending, de-duplicated App IDs", () => {
    const handoff = handoffFromSelection([620, 10, 620, 570]);
    expect(handoff).toEqual({
      name: "New Smart Collection",
      sourceAppIds: [10, 570, 620],
      rules: [
        {
          prefix: "AND",
          field: "game",
          operator: "in",
          value: [10, 570, 620],
        },
      ],
    });
  });

  it("is readable from router state and rejects malformed state", () => {
    const state = { smartCollectionDraft: handoffFromSelection([2, 1]) };
    expect(readDraftHandoff(state)?.sourceAppIds).toEqual([1, 2]);
    expect(readDraftHandoff(null)).toBeNull();
    expect(readDraftHandoff({})).toBeNull();
    expect(readDraftHandoff({ smartCollectionDraft: { name: "x" } })).toBeNull();
    expect(
      readDraftHandoff({
        smartCollectionDraft: {
          name: "x",
          sourceAppIds: [1],
          rules: [{ prefix: "AND", field: "tag", operator: "has", value: "Co-op" }],
        },
      }),
    ).toBeNull();
  });

  it("rejects a game Rule that the shared validator would reject", () => {
    for (const value of [[1, 1], [0], [-1], [1.5]]) {
      const state = {
        smartCollectionDraft: {
          name: "x",
          sourceAppIds: value,
          rules: [{ prefix: "AND", field: "game", operator: "in", value }],
        },
      };
      expect(readDraftHandoff(state), JSON.stringify(value)).toBeNull();
    }
  });
});
