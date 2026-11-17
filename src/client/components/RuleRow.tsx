import type { CSSProperties } from "react";
import {
  ActionIcon,
  Box,
  Button,
  Group,
  Input,
  NativeSelect,
  Paper,
  Stack,
  Text,
} from "@mantine/core";
import {
  RULE_FIELD_DEFINITIONS,
  RULE_PREFIXES,
  ruleFieldDefinition,
  type Rule,
  type RuleField,
  type RuleOperator,
  type RulePrefix,
  type RuleValue,
} from "../../shared/rules.ts";
import type { SteamCollectionSummary } from "../../shared/types.ts";
import { changeRuleField, changeRuleOperator, changeRulePrefix } from "../rule-editor.ts";
import { RuleValueControl, type RuleSuggestions } from "./RuleValueControl.tsx";

const OPERATOR_LABELS: Record<RuleOperator, string> = {
  is: "is",
  contains: "contains",
  has: "has",
  in: "is one of",
  lt: "is less than",
  lte: "is at most",
  gt: "is greater than",
  gte: "is at least",
};

const PREFIX_COLORS: Record<RulePrefix, string> = {
  AND: "blue",
  OR: "orange",
  NOT: "red",
};

const PREFIX_ACCENTS: Record<RulePrefix, string> = {
  AND: "var(--mantine-color-blue-6)",
  OR: "var(--mantine-color-orange-6)",
  NOT: "var(--mantine-color-red-6)",
};

export interface RuleRowProps {
  index: number;
  rule: Rule;
  fieldErrors: Record<string, string>;
  suggestions: RuleSuggestions;
  collections: SteamCollectionSummary[];
  selectedIds: number[];
  onChange(rule: Rule): void;
  onRemove(): void;
}

/** One prefix-first Rule row: Prefix, Field, Operator, value, remove. */
export function RuleRow({
  index,
  rule,
  fieldErrors,
  suggestions,
  collections,
  selectedIds,
  onChange,
  onRemove,
}: RuleRowProps) {
  const path = `rules.${index}`;
  const rowErrors = [
    fieldErrors[path],
    fieldErrors[`${path}.prefix`],
    fieldErrors[`${path}.field`],
    fieldErrors[`${path}.operator`],
    fieldErrors[`${path}.value`],
  ].filter((message): message is string => typeof message === "string" && message !== "");
  const invalid = rowErrors.length > 0;
  const fieldId = `rule-${index}-field`;
  const operatorId = `rule-${index}-operator`;
  const valueId = `rule-${index}-value`;
  const valueLabel =
    rule.field === "game" ? "Games" : rule.field === "playtime" ? "Hours" : "Value";

  return (
    <Paper
      component="li"
      className={`rule-row${invalid ? " is-invalid" : ""}`}
      data-rule-index={index}
      p="xs"
      radius="sm"
      withBorder
      style={{ "--rule-accent": PREFIX_ACCENTS[rule.prefix] } as CSSProperties}
    >
      <Stack gap={8}>
        <Group className="rule-head" justify="space-between" align="center" gap="xs" wrap="nowrap">
          <Box className="rule-prefix" role="group" aria-label={`Rule ${index + 1} prefix`}>
            <Button.Group>
              {RULE_PREFIXES.map((prefix) => {
                const active = rule.prefix === prefix;
                return (
                  <Button
                    key={prefix}
                    type="button"
                    size="compact-sm"
                    variant={active ? "filled" : "default"}
                    color={active ? PREFIX_COLORS[prefix] : "gray"}
                    aria-pressed={active}
                    aria-label={`${prefix} prefix for Rule ${index + 1}`}
                    miw={48}
                    px={6}
                    onClick={() => onChange(changeRulePrefix(rule, prefix as RulePrefix))}
                  >
                    {prefix}
                  </Button>
                );
              })}
            </Button.Group>
          </Box>
          <ActionIcon
            className="rule-remove"
            variant="subtle"
            aria-label={`Remove rule ${index + 1}`}
            onClick={onRemove}
          >
            ×
          </ActionIcon>
        </Group>

        <Box className="rule-fields">
          <NativeSelect
            className="rule-field"
            id={fieldId}
            label="Field"
            value={rule.field}
            data={RULE_FIELD_DEFINITIONS.map((definition) => ({
              value: definition.field,
              label: definition.label,
            }))}
            onChange={(event) =>
              onChange(changeRuleField(rule, event.currentTarget.value as RuleField))
            }
          />

          <NativeSelect
            className="rule-operator"
            id={operatorId}
            label="Operator"
            value={rule.operator}
            data={(ruleFieldDefinition(rule.field)?.operators ?? []).map((operator) => ({
              value: operator,
              label: OPERATOR_LABELS[operator],
            }))}
            onChange={(event) =>
              onChange(changeRuleOperator(rule, event.currentTarget.value as RuleOperator))
            }
          />

          <Input.Wrapper className="rule-value" id={valueId} label={valueLabel}>
            <RuleValueControl
              rule={rule}
              inputId={valueId}
              suggestions={suggestions}
              collections={collections}
              selectedIds={selectedIds}
              invalid={invalid}
              onChange={(value: RuleValue) => onChange({ ...rule, value })}
            />
          </Input.Wrapper>
        </Box>
      </Stack>

      {invalid && (
        <Stack
          component="ul"
          className="rule-errors"
          gap={2}
          mt="xs"
          aria-label={`Rule ${index + 1} validation`}
          style={{ listStyle: "none", padding: 0 }}
        >
          {rowErrors.map((message) => (
            <Text component="li" key={message} size="xs" c="red">
              {message}
            </Text>
          ))}
        </Stack>
      )}
    </Paper>
  );
}
