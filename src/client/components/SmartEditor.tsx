import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type {
  GameSummary,
  GamesResponse,
  RuleValueField,
  SteamCollectionSummary,
  TagsResponse,
} from "../../shared/types.ts";
import { validateRules, type Rule, type RuleField } from "../../shared/rules.ts";
import type { SmartCollection } from "../../shared/smart-collections.ts";
import {
  ApiError,
  createSmartCollection,
  deleteSmartCollection,
  fetchRuleValues,
  fetchSteamCollections,
  fetchTags,
  patchSmartCollection,
  previewRules,
} from "../api.ts";
import { useBrowse } from "../browse-context.tsx";
import { GameResults } from "./GameResults.tsx";
import { Pagination } from "./Pagination.tsx";
import { RuleRow } from "./RuleRow.tsx";
import { EMPTY_SUGGESTIONS, type RuleSuggestions } from "./RuleValueControl.tsx";
import { formatRange } from "../browse.ts";
import { formatTimestamp } from "../format.ts";
import {
  emptyRule,
  prefixCounts,
  togglePlatformRule,
  validateCollectionName,
  platformsInRules,
} from "../rule-editor.ts";
import { NEW_COLLECTION_NAME } from "../smart-handoff.ts";

const PAGE_SIZE = 60;
const QUICK_ADD_FIELDS: ReadonlyArray<{ field: RuleField; label: string }> = [
  { field: "tag", label: "Tag" },
  { field: "playtime", label: "Playtime" },
  { field: "steamCollection", label: "Steam collection" },
  { field: "game", label: "Game list" },
];

const RULE_VALUE_FIELDS: readonly RuleValueField[] = [
  "genre",
  "category",
  "developer",
  "publisher",
];

export interface SmartEditorProps {
  /** The saved Collection, or `null` for the explicit first save at `/smart/new`. */
  collection: SmartCollection | null;
  initialName?: string;
  initialRules?: Rule[];
  onSaved?(collection: SmartCollection): void;
  onDeleted?(): void;
}

interface Conflict {
  message: string;
  id: string | null;
}

/**
 * The Smart Collection editor (§7.4).
 *
 * #32 implements the explicit first Save and explicit PATCH saves for a saved
 * Collection. Autosave, save retry states, Add to current rules, and selection
 * clearing belong to #33.
 */
export function SmartEditor({
  collection,
  initialName,
  initialRules,
  onSaved,
  onDeleted,
}: SmartEditorProps) {
  const { sort, order, selectedIds } = useBrowse();
  const [name, setName] = useState(collection?.name ?? initialName ?? NEW_COLLECTION_NAME);
  const [rules, setRules] = useState<Rule[]>(collection?.rules ?? initialRules ?? []);
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState<GamesResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [collections, setCollections] = useState<SteamCollectionSummary[]>([]);
  const [suggestions, setSuggestions] = useState<RuleSuggestions>(EMPTY_SUGGESTIONS);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<string | null>(null);
  const [serverFieldErrors, setServerFieldErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const savedId = collection?.id ?? null;

  useEffect(() => {
    setName(collection?.name ?? initialName ?? NEW_COLLECTION_NAME);
    setRules(collection?.rules ?? initialRules ?? []);
    setPage(1);
    setServerFieldErrors({});
    setConflict(null);
    setSaveError(null);
    setSaveState(null);
    setConfirmingDelete(false);
    setDeleteError(null);
  }, [savedId]);

  const validation = validateRules(rules);
  const clientFieldErrors = validation.fieldErrors;
  const fieldErrors = useMemo(
    () => ({ ...clientFieldErrors, ...serverFieldErrors }),
    [clientFieldErrors, serverFieldErrors],
  );
  const validRules = validation.rules;
  const rulesInvalid = Object.keys(clientFieldErrors).length > 0;
  const signature = JSON.stringify(validRules);
  const previousSignature = useRef<string | null>(null);
  const localNameError = validateCollectionName(name);
  const nameError = localNameError ?? serverFieldErrors.name ?? conflict?.message ?? null;
  const saveDisabled = saving || deleting || localNameError !== null || rulesInvalid;

  useEffect(() => {
    const controller = new AbortController();
    void fetchSteamCollections({ pageSize: 200 }, controller.signal)
      .then((response) => setCollections(response.data))
      .catch((error: unknown) => {
        if ((error as Error).name !== "AbortError") {
          setCollections([]);
        }
      });
    void fetchTags({ pageSize: 100 }, controller.signal)
      .then((response: TagsResponse) =>
        setSuggestions((current) => ({ ...current, tags: response.data.map((tag) => tag.name) })),
      )
      .catch(() => undefined);
    for (const field of RULE_VALUE_FIELDS) {
      void fetchRuleValues({ field, pageSize: 100 }, controller.signal)
        .then((response) =>
          setSuggestions((current) => ({
            ...current,
            values: {
              ...current.values,
              [field]: response.data.map((entry) => entry.value),
            },
          })),
        )
        .catch(() => undefined);
    }
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const changed = previousSignature.current !== null && previousSignature.current !== signature;
    previousSignature.current = signature;
    if (rulesInvalid) {
      setPending(false);
      return;
    }
    const controller = new AbortController();
    let active = true;

    const start = (): void => {
      setPending(true);
      previewRules({ rules: validRules, page, pageSize: PAGE_SIZE, sort, order }, controller.signal)
        .then((response) => {
          if (!active) {
            return;
          }
          setPreview(response);
          setPreviewError(null);
          setPending(false);
        })
        .catch((error: unknown) => {
          if (!active || (error as Error).name === "AbortError") {
            return;
          }
          setPreviewError(
            error instanceof ApiError ? error.message : "The preview could not be loaded.",
          );
          setPending(false);
        });
    };

    const timer = window.setTimeout(start, changed ? 300 : 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [signature, page, sort, order, rulesInvalid]);

  const updateRules = useCallback((next: Rule[]) => {
    setRules(next);
    setPage(1);
    setServerFieldErrors({});
    setConflict(null);
    setSaveError(null);
    setSaveState(null);
  }, []);

  const updateName = (next: string): void => {
    setName(next);
    setServerFieldErrors({});
    setConflict(null);
    setSaveError(null);
    setSaveState(null);
  };

  const addRules = (next: Rule[]): void => updateRules([...rules, ...next]);

  const save = async (): Promise<void> => {
    if (saving || deleting) {
      return;
    }
    if (localNameError !== null || Object.keys(clientFieldErrors).length > 0) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    setServerFieldErrors({});
    setConflict(null);
    setSaveState(null);

    try {
      const saved =
        savedId === null
          ? await createSmartCollection({ name: name.trim(), rules: validRules })
          : await patchSmartCollection(savedId, { name: name.trim(), rules: validRules });
      setName(saved.name);
      setRules(saved.rules);
      setSaveState("Saved");
      onSaved?.(saved);
    } catch (error) {
      if (error instanceof ApiError && error.code === "NAME_CONFLICT") {
        const conflictingId = error.details?.conflictingId;
        setConflict({
          message: "A Smart Collection with this name already exists.",
          id: typeof conflictingId === "string" ? conflictingId : null,
        });
      } else if (error instanceof ApiError && error.status === 422) {
        setServerFieldErrors(error.fieldErrors);
      } else {
        setSaveError(
          error instanceof ApiError ? error.message : "The Smart Collection could not be saved.",
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (savedId === null || deleting) {
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteSmartCollection(savedId);
      onDeleted?.();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        onDeleted?.();
      } else {
        setDeleteError(
          error instanceof ApiError ? error.message : "The Smart Collection could not be deleted.",
        );
      }
    } finally {
      setDeleting(false);
    }
  };

  const counts = prefixCounts(rules);
  const rows: GameSummary[] = preview?.data ?? [];
  const totalItems = preview?.pagination.totalItems ?? 0;
  const totalPages = preview?.pagination.totalPages ?? 0;
  const dataAsOf = preview?.meta.dataAsOf ?? null;
  const selectedPlatforms = platformsInRules(rules);

  return (
    <section className="smart-editor" aria-labelledby="editor-heading">
      <h2 id="editor-heading" className="sr-only">
        {collection === null ? "New Smart Collection" : collection.name}
      </h2>

      <div className="editor-layout">
        <section className="editor-pane" aria-label="Rule editor">
          <div className="editor-name">
            <label htmlFor="collection-name">Name</label>
            <input
              id="collection-name"
              type="text"
              value={name}
              maxLength={80}
              aria-invalid={nameError !== null || undefined}
              aria-describedby={nameError === null ? undefined : "collection-name-error"}
              onChange={(event) => updateName(event.target.value)}
            />
            {nameError !== null && (
              <p className="field-error" id="collection-name-error" role="alert">
                {nameError}
                {conflict?.id != null && (
                  <>
                    {" "}
                    <Link to={`/smart/${encodeURIComponent(conflict.id)}`}>
                      Open the conflicting collection
                    </Link>
                    .
                  </>
                )}
              </p>
            )}
            {fieldErrors.rules !== undefined && (
              <p className="field-error" role="alert">
                {fieldErrors.rules}
              </p>
            )}
            <div className="editor-save">
              <button
                type="button"
                className="primary"
                onClick={() => void save()}
                disabled={saveDisabled}
              >
                {saving ? "Saving…" : "Save"}
              </button>
              {saveState !== null && <span className="editor-save-note">{saveState}</span>}
              {saving && <span className="editor-save-note">Saving…</span>}
              {savedId !== null && !confirmingDelete && (
                <button
                  type="button"
                  className="button button-small"
                  onClick={() => setConfirmingDelete(true)}
                  disabled={saving || deleting}
                >
                  Delete
                </button>
              )}
            </div>

            {confirmingDelete && (
              <div
                className="editor-confirm"
                role="alertdialog"
                aria-label="Delete Smart Collection"
              >
                <p>Delete “{name.trim() || "this Smart Collection"}”? This cannot be undone.</p>
                <div className="editor-save">
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => void remove()}
                    disabled={deleting}
                  >
                    {deleting ? "Deleting…" : "Delete"}
                  </button>
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => setConfirmingDelete(false)}
                    disabled={deleting}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {deleteError !== null && (
              <p className="field-error" role="alert">
                {deleteError}
              </p>
            )}
            {saveError !== null && (
              <p className="field-error" role="alert">
                {saveError}
              </p>
            )}
            {saveState === null && saveError === null && (
              <span className="editor-save-note">
                {savedId === null
                  ? "Save creates the Smart Collection."
                  : "Save applies your name and Rule changes."}
              </span>
            )}
          </div>

          <div className="editor-status">
            <p className="editor-match-count" aria-live="polite" data-testid="match-count">
              {preview === null
                ? rulesInvalid
                  ? "No preview yet"
                  : "Loading matches…"
                : `${totalItems} matches`}
            </p>
            {pending && (
              <span className="updating" role="status">
                Updating…
              </span>
            )}
          </div>

          <div className="prefix-callout" aria-label="Global prefix summary">
            <p className="prefix-counts" data-testid="prefix-counts">
              {counts.AND} AND · {counts.OR} OR · {counts.NOT} NOT
            </p>
            <p>
              Prefixes group globally: every AND must match, at least one OR must match, no NOT may
              match. They are not evaluated row by row.
            </p>
            <p className="prefix-not-copy">
              NOT removes matching games. It does not require the field to have a value.
            </p>
          </div>

          {rules.length === 0 ? (
            <p className="editor-no-rules">No rules yet. Add a rule below, or pick a quick add.</p>
          ) : (
            <ol className="rule-list">
              {rules.map((rule, index) => (
                <RuleRow
                  key={index}
                  index={index}
                  rule={rule}
                  fieldErrors={fieldErrors}
                  suggestions={suggestions}
                  collections={collections}
                  selectedIds={selectedIds}
                  onChange={(next) =>
                    updateRules(
                      rules.map((current, position) => (position === index ? next : current)),
                    )
                  }
                  onRemove={() => updateRules(rules.filter((_, position) => position !== index))}
                />
              ))}
            </ol>
          )}

          <div className="editor-actions">
            <button type="button" className="button" onClick={() => addRules([emptyRule()])}>
              + Add rule
            </button>
          </div>

          <section className="quick-add" aria-labelledby="quick-add-heading">
            <h3 id="quick-add-heading">Quick add</h3>
            <div className="quick-add-row">
              {QUICK_ADD_FIELDS.map((quick) => (
                <button
                  key={quick.field}
                  type="button"
                  className="button button-small"
                  onClick={() => addRules([emptyRule(quick.field)])}
                >
                  {quick.label}
                </button>
              ))}
            </div>
            <fieldset className="platform-add">
              <legend>Platform</legend>
              {["windows", "mac", "linux"].map((platform) => (
                <label key={platform}>
                  <input
                    type="checkbox"
                    checked={selectedPlatforms.includes(platform)}
                    onChange={() => updateRules(togglePlatformRule(rules, platform))}
                  />
                  {platform}
                </label>
              ))}
            </fieldset>
            <p className="quick-add-note">
              Each platform adds one <code>AND platform has</code> rule.
            </p>
          </section>
        </section>

        <section className="preview-pane" aria-label="Live preview">
          <header className="preview-head">
            {preview !== null && totalItems > 0 && !rulesInvalid && (
              <span className="preview-range">{formatRange(page, PAGE_SIZE, totalItems)}</span>
            )}
          </header>

          {rulesInvalid && (
            <p className="preview-invalid" role="status">
              Fix the highlighted rules to update the preview.
            </p>
          )}

          {previewError !== null && (
            <div className="banner banner-error" role="alert">
              <div>
                <strong>The preview could not be loaded.</strong>
                <p>{previewError}</p>
              </div>
            </div>
          )}

          {preview === null && !rulesInvalid && (
            <p className="preview-loading" role="status">
              Loading matches…
            </p>
          )}

          {preview !== null && rules.length === 0 && (
            <p className="editor-empty-copy" data-testid="empty-rules-copy">
              No rules. This matches all {totalItems} games. Add a rule to narrow it.
            </p>
          )}

          {preview !== null && rules.length > 0 && totalItems === 0 && (
            <p className="editor-empty-copy" data-testid="no-matches-copy">
              No games match these rules. An OR rule widens the result; a NOT rule removes games.
            </p>
          )}

          {preview !== null && rows.length > 0 && <GameResults games={rows} />}

          {preview !== null && totalItems > 0 && !rulesInvalid && (
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              totalItems={totalItems}
              totalPages={totalPages}
              onPageChange={setPage}
            />
          )}

          {dataAsOf !== null && (
            <footer className="results-footer">
              Data as of <time dateTime={dataAsOf}>{formatTimestamp(dataAsOf)}</time>
            </footer>
          )}
        </section>
      </div>
    </section>
  );
}
