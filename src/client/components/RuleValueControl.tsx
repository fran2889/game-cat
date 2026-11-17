import { useEffect, useState } from "react";
import { Checkbox, Group, NativeSelect, Text, TextInput } from "@mantine/core";
import { parseHoursToMinutes, formatMinutesAsHours, sortedGameIds } from "../rule-editor.ts";
import type { RuleValueField, SteamCollectionSummary } from "../../shared/types.ts";
import {
  ruleFieldDefinition,
  isRuleValueField,
  type Rule,
  type RuleValue,
} from "../../shared/rules.ts";
import { GamePicker } from "./GamePicker.tsx";

export interface RuleSuggestions {
  tags: string[];
  values: Record<RuleValueField, string[]>;
}

export const EMPTY_SUGGESTIONS: RuleSuggestions = {
  tags: [],
  values: { genre: [], category: [], developer: [], publisher: [] },
};

export interface RuleValueControlProps {
  rule: Rule;
  inputId: string;
  suggestions: RuleSuggestions;
  collections: SteamCollectionSummary[];
  selectedIds: number[];
  invalid: boolean;
  onChange(value: RuleValue): void;
}

function HoursInput({
  inputId,
  minutes,
  invalid,
  onChange,
}: {
  inputId: string;
  minutes: number;
  invalid: boolean;
  onChange(minutes: number): void;
}) {
  const [draft, setDraft] = useState(formatMinutesAsHours(minutes));

  useEffect(() => {
    const parsed = parseHoursToMinutes(draft);
    if (parsed === minutes) {
      return;
    }
    // Keep a half-typed value such as "1." rather than clearing the field while
    // the user is still typing; the Rule is invalid until it parses.
    if (parsed === null && draft.trim() !== "") {
      return;
    }
    setDraft(formatMinutesAsHours(minutes));
    // `draft` is intentionally read from this render only: syncing on minutes
    // changes is what protects external Rule updates from clobbering typing.
  }, [minutes]);

  return (
    <Group className="value-with-unit" gap={6} wrap="nowrap">
      <TextInput
        id={inputId}
        type="text"
        inputMode="decimal"
        value={draft}
        aria-invalid={invalid || undefined}
        placeholder="0"
        onChange={(event) => {
          const next = event.currentTarget.value;
          setDraft(next);
          const converted = parseHoursToMinutes(next);
          onChange(converted === null ? -1 : converted);
        }}
      />
      <Text component="span" className="unit" size="xs" c="gray.5">
        hours
      </Text>
    </Group>
  );
}

function NumberField({
  inputId,
  value,
  definition,
  invalid,
  onChange,
}: {
  inputId: string;
  value: number;
  definition: ReturnType<typeof ruleFieldDefinition>;
  invalid: boolean;
  onChange(value: number): void;
}) {
  return (
    <TextInput
      id={inputId}
      type="number"
      value={Number.isFinite(value) ? value : ""}
      min={definition?.min}
      max={definition?.max}
      step={1}
      aria-invalid={invalid || undefined}
      onChange={(event) => {
        const next = Number.parseInt(event.currentTarget.value, 10);
        onChange(Number.isSafeInteger(next) ? next : -1);
      }}
    />
  );
}

/** The value half of a Rule row, chosen by the Field's registry entry. */
export function RuleValueControl({
  rule,
  inputId,
  suggestions,
  collections,
  selectedIds,
  invalid,
  onChange,
}: RuleValueControlProps) {
  const definition = ruleFieldDefinition(rule.field);
  if (definition === undefined) {
    return null;
  }
  const value = rule.value;

  switch (definition.valueKind) {
    case "boolean":
      return (
        <Group className="value-with-unit" gap={6} wrap="nowrap">
          <Checkbox
            id={inputId}
            size="md"
            styles={{ input: { width: 24, height: 24 } }}
            checked={value === true}
            aria-invalid={invalid || undefined}
            onChange={(event) => onChange(event.currentTarget.checked)}
          />
          <Text component="span" className="unit" size="xs" c="gray.5">
            {value === true ? "true" : "false"}
          </Text>
        </Group>
      );

    case "enum":
      return (
        <NativeSelect
          id={inputId}
          value={typeof value === "string" ? value : ""}
          aria-invalid={invalid || undefined}
          data={definition.values ?? []}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      );

    case "date":
      return (
        <TextInput
          id={inputId}
          type="date"
          min="1970-01-01"
          max="9999-12-31"
          value={typeof value === "string" ? value : ""}
          aria-invalid={invalid || undefined}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      );

    case "integer":
      if (rule.field === "playtime") {
        return (
          <HoursInput
            inputId={inputId}
            minutes={typeof value === "number" ? value : 0}
            invalid={invalid}
            onChange={onChange}
          />
        );
      }
      return (
        <NumberField
          inputId={inputId}
          value={typeof value === "number" ? value : Number.NaN}
          definition={definition}
          invalid={invalid}
          onChange={onChange}
        />
      );

    case "steamCollection": {
      const current = typeof value === "string" ? value : "";
      const known = collections.some((collection) => collection.id === current);
      const data = [
        { value: "", label: "Choose a Steam collection" },
        ...(!known && current !== ""
          ? [{ value: current, label: `${current} (not mirrored)` }]
          : []),
        ...collections.map((collection) => ({
          value: collection.id,
          label: `${collection.name}${collection.isDynamic ? " (dynamic)" : ""}`,
          disabled: collection.isDynamic,
        })),
      ];
      return (
        <NativeSelect
          id={inputId}
          value={current}
          aria-invalid={invalid || undefined}
          data={data}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      );
    }

    case "appIds":
      return (
        <GamePicker
          inputId={inputId}
          value={Array.isArray(value) ? value : []}
          selectedIds={selectedIds}
          onChange={(appIds) => onChange(sortedGameIds(appIds))}
        />
      );

    case "text":
    case "openEnum":
    case "multiText": {
      const listId = `${inputId}-suggestions`;
      const options =
        rule.field === "tag"
          ? suggestions.tags
          : isRuleValueField(rule.field)
            ? suggestions.values[rule.field]
            : [];
      return (
        <>
          <TextInput
            id={inputId}
            type="text"
            value={typeof value === "string" ? value : ""}
            list={options.length > 0 ? listId : undefined}
            autoComplete="off"
            aria-invalid={invalid || undefined}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
          {options.length > 0 && (
            <datalist id={listId}>
              {options.map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
          )}
        </>
      );
    }
  }
}
