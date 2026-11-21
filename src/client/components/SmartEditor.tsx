import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "react-router-dom";
import {
  ActionIcon,
  Alert,
  Anchor,
  Box,
  Button,
  Checkbox,
  Code,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
  VisuallyHidden,
} from "@mantine/core";
import { IconInfoCircle, IconPlus, IconTrash } from "@tabler/icons-react";
import type {
  GameSummary,
  GamesResponse,
  RuleValueField,
  SteamCollectionSummary,
} from "../../shared/types.ts";
import {
  MAX_GAME_RULE_IDS,
  RULE_VALUE_FIELDS,
  ruleFieldDefinition,
  validateRules,
  type Rule,
  type RuleField,
} from "../../shared/rules.ts";
import type { SmartCollection } from "../../shared/smart-collections.ts";
import {
  ApiError,
  createSmartCollection,
  deleteSmartCollection,
  patchSmartCollection,
  previewRules,
  ruleValuesQueryOptions,
  steamCollectionsQueryOptions,
  tagsQueryOptions,
  type PreviewRulesBody,
} from "../api.ts";
import {
  AutosaveController,
  type AutosaveSnapshot,
  type AutosaveState,
  type AutosaveStatus,
} from "../autosave.ts";
import { useBrowse } from "../browse-context.tsx";
import { GameGridSkeleton } from "./GameGridSkeleton.tsx";
import { GameResults } from "./GameResults.tsx";
import { Pagination } from "./Pagination.tsx";
import { RuleRow } from "./RuleRow.tsx";
import { type RuleSuggestions } from "./RuleValueControl.tsx";
import { SelectionBar } from "./SelectionBar.tsx";
import { useToast } from "./ToastProvider.tsx";
import { formatRange } from "../browse.ts";
import { formatCount, formatTimestamp } from "../format.ts";
import {
  addSelectionToGameRule,
  emptyRule,
  mergedGameRuleIds,
  prefixCounts,
  togglePlatformRule,
  validateCollectionName,
  platformsInRules,
} from "../rule-editor.ts";
import { NEW_COLLECTION_NAME } from "../smart-handoff.ts";

const PAGE_SIZE = 60;
/** The editor curates these shortcuts; their labels come from the Field registry. */
const QUICK_ADD_FIELDS: readonly RuleField[] = ["tag", "playtime", "steamCollection", "game"];
const PLATFORM_VALUES = ruleFieldDefinition("platform")?.values ?? [];

const AUTOSAVE_LABELS: Partial<Record<AutosaveStatus, string>> = {
  saved: "Saved",
  saving: "Saving…",
  unsaved: "Unsaved changes",
  failed: "Save failed",
};

/** The rail header dot mirrors the autosave state without adding another word. */
const AUTOSAVE_DOT_COLORS: Partial<Record<AutosaveStatus, string>> = {
  saved: "var(--mantine-color-green-6)",
  saving: "var(--mantine-color-yellow-6)",
  unsaved: "var(--mantine-color-yellow-6)",
  failed: "var(--mantine-color-red-6)",
};

/** One copy source for both navigation-guard reasons. */
const LEAVE_CONFIRMATIONS = {
  failed: {
    label: "Leave with a failed save",
    message: "Your latest changes could not be saved. Leave this page and lose those changes?",
  },
  draft: {
    label: "Leave with unsaved changes",
    message: "This Smart Collection has not been saved. Leave and discard the draft?",
  },
} as const;

const EMPTY_AUTOSAVE_STATE: AutosaveState = {
  status: "idle",
  dirty: false,
  retrying: false,
  retryDelay: null,
  retryAttempt: 0,
  lastError: null,
  canRetry: false,
};

/** A 409/422/404 needs the user to change something; transport and 500s retry. */
function isRetryableSaveError(error: unknown): boolean {
  return !(
    error instanceof ApiError &&
    (error.status === 409 || error.status === 422 || error.status === 404)
  );
}

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
 * A new Smart Collection is created by the explicit first Save. After that the
 * AutosaveController owns debounced name/Rule saves, the retry schedule, and
 * the failure navigation guard; the preview remains a separate 300 ms debounce.
 */
export function SmartEditor({
  collection,
  initialName,
  initialRules,
  onSaved,
  onDeleted,
}: SmartEditorProps) {
  const { sort, order, selectedIds, selectedCount, selectShown, clearShown } = useBrowse();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState(collection?.name ?? initialName ?? NEW_COLLECTION_NAME);
  const [rules, setRules] = useState<Rule[]>(collection?.rules ?? initialRules ?? []);
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState<GamesResponse | null>(null);
  const [previewInput, setPreviewInput] = useState<PreviewRulesBody | null>(null);
  const [creating, setCreating] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [serverFieldErrors, setServerFieldErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [autosaveState, setAutosaveState] = useState<AutosaveState>(EMPTY_AUTOSAVE_STATE);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const steamCollectionsQuery = useQuery(steamCollectionsQueryOptions({ pageSize: 200 }));
  const collections: SteamCollectionSummary[] = steamCollectionsQuery.data?.data ?? [];
  const tagsQuery = useQuery(tagsQueryOptions({ pageSize: 100 }));
  const valueQueries = useQueries({
    queries: RULE_VALUE_FIELDS.map((field) => ruleValuesQueryOptions({ field, pageSize: 100 })),
  });
  const suggestions = useMemo<RuleSuggestions>(() => {
    const values: Record<RuleValueField, string[]> = {
      genre: [],
      category: [],
      developer: [],
      publisher: [],
    };
    RULE_VALUE_FIELDS.forEach((field, index) => {
      values[field] = valueQueries[index]?.data?.data.map((entry) => entry.value) ?? [];
    });
    return {
      tags: tagsQuery.data?.data.map((tag) => tag.name) ?? [],
      values,
    };
  }, [tagsQuery.data, valueQueries]);

  const createMutation = useMutation({ mutationFn: createSmartCollection });
  const deleteMutation = useMutation({ mutationFn: deleteSmartCollection });
  const patchMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: AutosaveSnapshot }) =>
      patchSmartCollection(id, body),
  });
  const patchMutationRef = useRef(patchMutation);
  patchMutationRef.current = patchMutation;

  const initialDraft = {
    name: initialName ?? NEW_COLLECTION_NAME,
    rules: initialRules ?? [],
  };
  const savedId = collection?.id ?? null;
  const savedIdRef = useRef(savedId);
  savedIdRef.current = savedId;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const allowNavigationRef = useRef(false);
  const saveFailed = autosaveState.status === "failed" || autosaveState.lastError !== null;
  const failedRef = useRef(false);
  failedRef.current = saveFailed;
  const draftDirty = savedId === null && autosaveState.dirty;
  const draftDirtyRef = useRef(false);
  draftDirtyRef.current = draftDirty;

  function applySaveError(error: unknown): void {
    if (error instanceof ApiError && error.code === "NAME_CONFLICT") {
      const conflictingId = error.details?.conflictingId;
      setConflict({
        message: "A Smart Collection with this name already exists.",
        id: typeof conflictingId === "string" ? conflictingId : null,
      });
      return;
    }
    if (error instanceof ApiError && error.status === 422) {
      setServerFieldErrors(error.fieldErrors);
      return;
    }
    if (isRetryableSaveError(error) && savedIdRef.current !== null) {
      // The controller shows the retry/server-unavailable message for saved
      // Collections; an explicit first save has no retry path.
      return;
    }
    setSaveError(
      error instanceof ApiError ? error.message : "The Smart Collection could not be saved.",
    );
  }

  const autosaveRef = useRef<AutosaveController | null>(null);
  if (autosaveRef.current === null) {
    autosaveRef.current = new AutosaveController({
      save: async (snapshot: AutosaveSnapshot) => {
        const id = savedIdRef.current;
        if (id === null) {
          throw new Error("A new Smart Collection has no autosave target.");
        }
        setSaveError(null);
        setServerFieldErrors({});
        setConflict(null);
        try {
          const saved = await patchMutationRef.current.mutateAsync({ id, body: snapshot });
          onSavedRef.current?.(saved);
          return { name: saved.name, rules: saved.rules };
        } catch (error) {
          applySaveError(error);
          throw error;
        }
      },
      isRetryable: isRetryableSaveError,
      onChange: setAutosaveState,
    });
  }
  const autosave = autosaveRef.current;

  useEffect(() => {
    setName(collection?.name ?? initialName ?? NEW_COLLECTION_NAME);
    setRules(collection?.rules ?? initialRules ?? []);
    setPage(1);
    setServerFieldErrors({});
    setConflict(null);
    setSaveError(null);
    setConfirmingDelete(false);
    setDeleteError(null);
  }, [savedId]);

  useEffect(() => {
    autosave.reset(
      savedId === null || collection === null
        ? null
        : { name: collection.name, rules: collection.rules },
      savedId === null ? initialDraft : undefined,
    );
  }, [autosave, savedId]);

  useEffect(() => () => autosave.dispose(), [autosave]);

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
  const saving = savedId === null ? creating : autosaveState.status === "saving";
  const saveDisabled = saving || deleting || localNameError !== null || rulesInvalid;

  useEffect(() => {
    autosave.updateDraft({ name, rules }, localNameError === null && !rulesInvalid);
  }, [autosave, name, rules, localNameError, rulesInvalid]);

  useEffect(() => {
    const changed = previousSignature.current !== null && previousSignature.current !== signature;
    previousSignature.current = signature;
    if (rulesInvalid) {
      setPreviewInput(null);
      return;
    }
    const body = { rules: validRules, page, pageSize: PAGE_SIZE, sort, order };
    const timer = window.setTimeout(() => setPreviewInput(body), changed ? 300 : 0);
    return () => window.clearTimeout(timer);
  }, [signature, page, sort, order, rulesInvalid]);

  const previewQuery = useQuery({
    queryKey: ["rules-preview", previewInput],
    queryFn: ({ signal }) => previewRules(previewInput as PreviewRulesBody, signal),
    enabled: previewInput !== null,
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    if (previewQuery.data !== undefined) {
      setPreview(previewQuery.data);
    }
  }, [previewQuery.data]);

  const pending = previewQuery.isFetching;
  const previewError =
    previewQuery.error === null
      ? null
      : previewQuery.error instanceof ApiError
        ? previewQuery.error.message
        : "The preview could not be loaded.";

  const updateRules = useCallback(
    (next: Rule[]) => {
      const nextInvalid = Object.keys(validateRules(next).fieldErrors).length > 0;
      autosave.updateDraft({ name, rules: next }, localNameError === null && !nextInvalid);
      setRules(next);
      setPage(1);
      setServerFieldErrors({});
      setConflict(null);
      setSaveError(null);
    },
    [autosave, localNameError, name],
  );

  const updateName = (next: string): void => {
    autosave.updateDraft(
      { name: next, rules },
      validateCollectionName(next) === null && !rulesInvalid,
    );
    setName(next);
    setServerFieldErrors({});
    setConflict(null);
    setSaveError(null);
  };

  const addRules = (next: Rule[]): void => updateRules([...rules, ...next]);

  const create = async (): Promise<void> => {
    if (creating || deleting || localNameError !== null || rulesInvalid) {
      return;
    }
    setCreating(true);
    setSaveError(null);
    setServerFieldErrors({});
    setConflict(null);
    try {
      const saved = await createMutation.mutateAsync({ name: name.trim(), rules: validRules });
      autosave.markSaved({ name: saved.name, rules: saved.rules });
      setName(saved.name);
      setRules(saved.rules);
      allowNavigationRef.current = true;
      onSaved?.(saved);
    } catch (error) {
      applySaveError(error);
    } finally {
      setCreating(false);
    }
  };

  const save = (): void => {
    if (saveDisabled) {
      return;
    }
    if (savedId === null) {
      void create();
      return;
    }
    autosave.saveNow();
  };

  const discard = (): void => {
    if (saving || deleting) {
      return;
    }
    if (savedId === null) {
      // A new Smart Collection has no saved state to restore; Discard leaves
      // the explicit first-save flow without creating anything. A dirty draft
      // is caught by the navigation blocker below.
      navigate("/");
      return;
    }
    const snapshot = autosave.discard();
    if (snapshot === null) {
      return;
    }
    setName(snapshot.name);
    setRules(snapshot.rules);
    setPage(1);
    setServerFieldErrors({});
    setConflict(null);
    setSaveError(null);
  };

  const remove = async (): Promise<void> => {
    if (savedId === null || deleting) {
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    autosave.cancelPending();
    try {
      await deleteMutation.mutateAsync(savedId);
      allowNavigationRef.current = true;
      autosave.dispose();
      onDeleted?.();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        allowNavigationRef.current = true;
        autosave.dispose();
        onDeleted?.();
      } else {
        setDeleteError(
          error instanceof ApiError ? error.message : "The Smart Collection could not be deleted.",
        );
        autosave.reschedule();
      }
    } finally {
      setDeleting(false);
    }
  };

  const saveActionRef = useRef<() => void>(() => undefined);
  saveActionRef.current = save;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") {
        return;
      }
      event.preventDefault();
      saveActionRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      (failedRef.current || draftDirtyRef.current) &&
      !allowNavigationRef.current &&
      currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (!saveFailed) {
      return;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [saveFailed]);

  const mergedGameIds = mergedGameRuleIds(rules, selectedIds);
  const addToRulesTooLarge = mergedGameIds.length > MAX_GAME_RULE_IDS;
  const addToRulesDisabledReason = addToRulesTooLarge
    ? `Add to current rules supports up to ${formatCount(MAX_GAME_RULE_IDS)} Games in the game Rule.`
    : undefined;

  const addSelectionToRules = (): void => {
    const next = addSelectionToGameRule(rules, selectedIds);
    if (next === null) {
      return;
    }
    updateRules(next);
    showToast(
      `${formatCount(selectedCount)} selected ${selectedCount === 1 ? "game" : "games"} added to the current game Rule.`,
    );
  };

  const counts = prefixCounts(rules);
  const rows: GameSummary[] = preview?.data ?? [];
  const totalItems = preview?.pagination.totalItems ?? 0;
  const totalPages = preview?.pagination.totalPages ?? 0;
  const dataAsOf = preview?.meta.dataAsOf ?? null;
  const selectedPlatforms = platformsInRules(rules);
  const shownAppIds = rows.map((game) => game.appId);
  const allShownSelected =
    shownAppIds.length > 0 && shownAppIds.every((appId) => selectedIds.includes(appId));
  const toggleShownSelection = (): void => {
    if (allShownSelected) {
      clearShown(shownAppIds);
    } else {
      selectShown(shownAppIds);
    }
  };
  const leaveConfirmation = LEAVE_CONFIRMATIONS[failedRef.current ? "failed" : "draft"];

  return (
    <Stack component="section" className="smart-editor" aria-labelledby="editor-heading" gap="md">
      <VisuallyHidden>
        <Title order={2} id="editor-heading">
          {collection === null ? "New Smart Collection" : collection.name}
        </Title>
      </VisuallyHidden>

      <Box className="editor-layout">
        <Paper
          component="section"
          aria-label="Rule editor"
          className="editor-pane"
          miw={0}
          p="md"
          radius="md"
          withBorder
        >
          <Stack gap="sm">
            <Group className="editor-head" justify="space-between" gap="xs" wrap="nowrap">
              <Text className="editor-heading" size="xs" tt="uppercase" c="gray.5" fw={600}>
                Smart Collection
              </Text>
              {savedId !== null && AUTOSAVE_LABELS[autosaveState.status] !== undefined && (
                <Group className="editor-save-state-group" gap={5} wrap="nowrap">
                  <Box
                    className={`editor-save-dot is-${autosaveState.status}`}
                    aria-hidden="true"
                    w={6}
                    h={6}
                    style={{
                      borderRadius: "50%",
                      background: AUTOSAVE_DOT_COLORS[autosaveState.status],
                    }}
                  />
                  <Text
                    className={`editor-save-state is-${autosaveState.status}`}
                    role="status"
                    aria-live="polite"
                    data-testid="save-state"
                    size="xs"
                    c={autosaveState.status === "failed" ? "red" : "gray.5"}
                  >
                    {AUTOSAVE_LABELS[autosaveState.status]}
                  </Text>
                </Group>
              )}
            </Group>

            <Box className="editor-name">
              <TextInput
                id="collection-name"
                aria-label="Name"
                value={name}
                aria-invalid={nameError !== null || undefined}
                aria-describedby={nameError === null ? undefined : "collection-name-error"}
                onChange={(event) => updateName(event.currentTarget.value)}
              />
              {nameError !== null && (
                <Text
                  className="field-error"
                  id="collection-name-error"
                  role="alert"
                  size="sm"
                  c="red"
                >
                  {nameError}
                  {conflict?.id != null && (
                    <>
                      {" "}
                      <Anchor
                        component={Link}
                        to={`/smart/${encodeURIComponent(conflict.id)}`}
                        size="sm"
                        underline="always"
                      >
                        Open the conflicting collection
                      </Anchor>
                      .
                    </>
                  )}
                </Text>
              )}
              {fieldErrors.rules !== undefined && (
                <Text className="field-error" role="alert" size="sm" c="red">
                  {fieldErrors.rules}
                </Text>
              )}
            </Box>

            <Group className="editor-save" gap="xs" wrap="wrap">
              <Button size="compact-sm" onClick={save} disabled={saveDisabled}>
                Save
              </Button>
              <Button
                variant="default"
                size="compact-sm"
                onClick={discard}
                disabled={saving || deleting}
              >
                Discard
              </Button>
              {savedId !== null && !confirmingDelete && (
                <ActionIcon
                  className="editor-delete"
                  variant="subtle"
                  color="gray"
                  aria-label="Delete"
                  title="Delete Smart Collection"
                  onClick={() => setConfirmingDelete(true)}
                  disabled={saving || deleting}
                  ml="auto"
                >
                  <IconTrash size={15} aria-hidden="true" />
                </ActionIcon>
              )}
            </Group>

            {autosaveState.status === "failed" && autosaveState.canRetry && (
              <Alert className="editor-save-failure" color="red" role="alert">
                <Group gap="sm" wrap="wrap">
                  <Text size="sm">
                    {autosaveState.retrying && autosaveState.retryDelay !== null
                      ? `Save failed. Retrying in ${Math.ceil(autosaveState.retryDelay / 1_000)} s…`
                      : "Save failed. The server may be unavailable. Your changes are still here."}
                  </Text>
                  <Button variant="default" size="compact-sm" onClick={() => autosave.retryNow()}>
                    Retry
                  </Button>
                </Group>
              </Alert>
            )}

            {confirmingDelete && (
              <Paper
                className="editor-confirm"
                role="alertdialog"
                aria-label="Delete Smart Collection"
                p="sm"
                withBorder
              >
                <Stack gap="sm">
                  <Text size="sm">
                    Delete “{name.trim() || "this Smart Collection"}”? This cannot be undone.
                  </Text>
                  <Group gap="xs">
                    <Button
                      variant="default"
                      size="compact-sm"
                      onClick={() => void remove()}
                      disabled={deleting}
                    >
                      {deleting ? "Deleting…" : "Delete"}
                    </Button>
                    <Button
                      variant="default"
                      size="compact-sm"
                      onClick={() => setConfirmingDelete(false)}
                      disabled={deleting}
                    >
                      Cancel
                    </Button>
                  </Group>
                </Stack>
              </Paper>
            )}

            {deleteError !== null && (
              <Text className="field-error" role="alert" size="sm" c="red">
                {deleteError}
              </Text>
            )}
            {saveError !== null && (
              <Text className="field-error" role="alert" size="sm" c="red">
                {saveError}
              </Text>
            )}
            {saveError === null && savedId === null && (
              <Text className="editor-save-note" size="xs" c="gray.5">
                Save creates the Smart Collection.
              </Text>
            )}
            {saveError === null && savedId !== null && autosaveState.status === "saved" && (
              <Text className="editor-save-note" size="xs" c="gray.5">
                Changes save automatically · Rules save as a whole array.
              </Text>
            )}

            {blocker.state === "blocked" && (
              <Paper
                className="editor-confirm"
                role="alertdialog"
                aria-label={leaveConfirmation.label}
                p="sm"
                withBorder
              >
                <Stack gap="sm">
                  <Text size="sm">{leaveConfirmation.message}</Text>
                  <Group gap="xs">
                    <Button variant="default" size="compact-sm" onClick={() => blocker.proceed()}>
                      Leave
                    </Button>
                    <Button variant="default" size="compact-sm" onClick={() => blocker.reset()}>
                      Stay
                    </Button>
                  </Group>
                </Stack>
              </Paper>
            )}
            <Group className="editor-status" gap="sm" align="baseline" wrap="nowrap">
              <Text
                component="p"
                className="editor-match-count"
                aria-live="polite"
                data-testid="match-count"
                m={0}
              >
                {preview === null ? (
                  rulesInvalid ? (
                    "No preview yet"
                  ) : (
                    "Loading matches…"
                  )
                ) : (
                  <>
                    <Text span className="editor-match-total" fw={700} size="lg">
                      {totalItems}
                    </Text>{" "}
                    {totalItems === 1 ? "game matches" : "games match"}{" "}
                    <Text span className="editor-match-hint" size="xs" c="gray.5">
                      · updates as you edit
                    </Text>
                  </>
                )}
              </Text>
              {pending && (
                <Text className="updating" role="status" size="sm" c="yellow">
                  Updating…
                </Text>
              )}
            </Group>

            <Alert
              className="prefix-callout"
              aria-label="Global prefix summary"
              color="blue"
              variant="light"
              icon={<IconInfoCircle size={16} aria-hidden="true" />}
              p="xs"
              radius="sm"
            >
              <Stack gap={4}>
                <Text className="prefix-counts" data-testid="prefix-counts" size="xs" fw={700}>
                  {counts.AND} AND · {counts.OR} OR · {counts.NOT} NOT
                </Text>
                <Text size="xs" c="gray.5">
                  Prefixes group globally: every AND must match, at least one OR must match, no NOT
                  may match. They are not evaluated row by row.
                </Text>
                <Text className="prefix-not-copy" size="xs" c="gray.5">
                  NOT removes matching games. It does not require the field to have a value.
                </Text>
              </Stack>
            </Alert>

            {rules.length === 0 ? (
              <Text className="editor-no-rules" size="sm" c="gray.5">
                No rules yet. Add a rule below, or pick a quick add.
              </Text>
            ) : (
              <Stack
                component="ol"
                className="rule-list"
                gap="xs"
                style={{ listStyle: "none", padding: 0, margin: 0 }}
              >
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
              </Stack>
            )}

            <Group className="editor-actions" gap="xs">
              <Button
                variant="default"
                size="compact-sm"
                fullWidth
                leftSection={<IconPlus size={14} aria-hidden="true" />}
                aria-label="+ Add rule"
                onClick={() => addRules([emptyRule()])}
              >
                Add rule
              </Button>
            </Group>

            <Paper className="quick-add" p="xs" radius="sm" withBorder>
              <Stack gap="xs">
                <Title order={3} size="xs" c="gray.5" tt="uppercase">
                  Quick add
                </Title>
                <Group className="quick-add-row" gap="xs" wrap="wrap">
                  {QUICK_ADD_FIELDS.map((field) => (
                    <Button
                      key={field}
                      variant="default"
                      size="compact-sm"
                      onClick={() => addRules([emptyRule(field)])}
                    >
                      {ruleFieldDefinition(field)?.label ?? field}
                    </Button>
                  ))}
                </Group>
                <Box className="platform-add" role="group" aria-labelledby="platform-label">
                  <Text component="p" id="platform-label" size="xs" c="gray.5" mb={4}>
                    Platform
                  </Text>
                  <Group gap="md" wrap="wrap">
                    {PLATFORM_VALUES.map((platform) => (
                      <Checkbox
                        key={platform}
                        size="xs"
                        label={platform}
                        checked={selectedPlatforms.includes(platform)}
                        onChange={() => updateRules(togglePlatformRule(rules, platform))}
                      />
                    ))}
                  </Group>
                </Box>
                <Text className="quick-add-note" size="xs" c="gray.5">
                  Each platform adds one <Code>AND platform has</Code> rule.
                </Text>
              </Stack>
            </Paper>
          </Stack>
        </Paper>
        <Stack
          component="section"
          aria-label="Live preview"
          aria-busy={pending}
          className="preview-pane"
          miw={0}
          gap="sm"
        >
          {preview !== null && totalItems > 0 && !rulesInvalid && (
            <Group className="preview-head" justify="space-between" gap="sm" wrap="nowrap">
              <Text className="preview-range" size="sm" c="gray.5">
                {formatRange(page, PAGE_SIZE, totalItems)}
              </Text>
              {rows.length > 0 && (
                <Button variant="default" size="compact-sm" onClick={toggleShownSelection}>
                  {allShownSelected ? "Clear shown" : "Select shown"}
                </Button>
              )}
            </Group>
          )}

          {selectedCount > 0 && (
            <SelectionBar
              onAddToRules={savedId === null ? undefined : addSelectionToRules}
              addToRulesDisabled={addToRulesTooLarge}
              addToRulesDisabledReason={addToRulesDisabledReason}
            />
          )}

          {rulesInvalid && (
            <Text className="preview-invalid" role="status" size="sm" c="red">
              Fix the highlighted rules to update the preview.
            </Text>
          )}

          {previewError !== null && (
            <Alert color="red" role="alert" title="The preview could not be loaded.">
              <Text size="sm">{previewError}</Text>
            </Alert>
          )}

          {preview === null && !rulesInvalid && (
            <GameGridSkeleton label="Loading matches" count={6} />
          )}

          {preview !== null && rules.length === 0 && (
            <Paper className="editor-empty-copy" p="md" radius="md" withBorder>
              <Text size="sm" c="gray.5" data-testid="empty-rules-copy">
                No rules. This matches all {totalItems} games. Add a rule to narrow it.
              </Text>
            </Paper>
          )}

          {preview !== null && rules.length > 0 && totalItems === 0 && (
            <Paper className="editor-empty-copy" p="md" radius="md" withBorder>
              <Text size="sm" c="gray.5" data-testid="no-matches-copy">
                No games match these rules. An OR rule widens the result; a NOT rule removes games.
              </Text>
            </Paper>
          )}

          {preview !== null && rows.length > 0 && <GameResults games={rows} forceGrid />}

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
            <Text component="footer" className="results-footer" size="xs" c="gray.5" ta="center">
              Data as of <time dateTime={dataAsOf}>{formatTimestamp(dataAsOf)}</time>
            </Text>
          )}
        </Stack>
      </Box>
    </Stack>
  );
}
