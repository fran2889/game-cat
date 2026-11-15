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
    <li className={`rule-row${invalid ? " is-invalid" : ""}`} data-rule-index={index}>
      <div className="rule-prefix" role="group" aria-label={`Rule ${index + 1} prefix`}>
        {RULE_PREFIXES.map((prefix) => (
          <button
            key={prefix}
            type="button"
            className={`seg-button prefix-${prefix.toLowerCase()}`}
            aria-pressed={rule.prefix === prefix}
            aria-label={`${prefix} prefix for Rule ${index + 1}`}
            onClick={() => onChange(changeRulePrefix(rule, prefix as RulePrefix))}
          >
            {prefix}
          </button>
        ))}
      </div>

      <div className="rule-field">
        <label htmlFor={fieldId}>Field</label>
        <select
          id={fieldId}
          value={rule.field}
          onChange={(event) => onChange(changeRuleField(rule, event.target.value as RuleField))}
        >
          {RULE_FIELD_DEFINITIONS.map((definition) => (
            <option key={definition.field} value={definition.field}>
              {definition.label}
            </option>
          ))}
        </select>
      </div>

      <div className="rule-operator">
        <label htmlFor={operatorId}>Operator</label>
        <select
          id={operatorId}
          value={rule.operator}
          onChange={(event) =>
            onChange(changeRuleOperator(rule, event.target.value as RuleOperator))
          }
        >
          {(ruleFieldDefinition(rule.field)?.operators ?? []).map((operator) => (
            <option key={operator} value={operator}>
              {OPERATOR_LABELS[operator]}
            </option>
          ))}
        </select>
      </div>

      <div className="rule-value">
        <label htmlFor={valueId}>{valueLabel}</label>
        <RuleValueControl
          rule={rule}
          inputId={valueId}
          suggestions={suggestions}
          collections={collections}
          selectedIds={selectedIds}
          invalid={invalid}
          onChange={(value: RuleValue) => onChange({ ...rule, value })}
        />
      </div>

      <button
        type="button"
        className="icon-button rule-remove"
        aria-label={`Remove rule ${index + 1}`}
        onClick={onRemove}
      >
        ×
      </button>

      {invalid && (
        <ul className="rule-errors" aria-label={`Rule ${index + 1} validation`}>
          {rowErrors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </li>
  );
}
