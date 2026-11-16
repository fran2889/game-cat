import { ERROR_CODES } from "../shared/types.ts";
import { HttpError } from "./errors.ts";

/**
 * The request-parsing primitives shared by every route: one integer parser,
 * one validation-error builder, one record narrowing, and one not-found
 * helper. Behaviour is fixed by spec §4.3 and the contract suite, so a route
 * cannot grow its own variant.
 */

export type RawQuery = Record<string, string | undefined>;

/** Which request part a validation error describes; the message names it. */
export type ValidationSubject = "query" | "body";

/** The documented 422 envelope with dotted-path or field-level errors. */
export function validationError(
  fieldErrors: Record<string, string>,
  subject: ValidationSubject = "query",
): HttpError {
  return new HttpError(422, ERROR_CODES.validationError, `Request ${subject} is invalid`, {
    details: { fieldErrors },
  });
}

/**
 * Parse an optional non-negative decimal query integer within `[min, max]`.
 * Absent and empty values take the fallback; anything else that is not a
 * decimal integer in range records one field error and keeps the fallback.
 */
export function parseInteger(
  value: string | undefined,
  fallback: number,
  field: string,
  min: number,
  max: number,
  fieldErrors: Record<string, string>,
): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  if (!/^\d+$/.test(value)) {
    fieldErrors[field] = `must be an integer between ${min} and ${max}`;
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    fieldErrors[field] = `must be an integer between ${min} and ${max}`;
    return fallback;
  }
  return parsed;
}

/** Narrow an unknown JSON body to a plain object, rejecting arrays and null. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The documented 404 envelope, carrying the identifier the caller supplied. */
export function notFound(identifier: string, resource = "resource"): HttpError {
  return new HttpError(404, ERROR_CODES.notFound, `The requested ${resource} was not found.`, {
    details: { id: identifier },
  });
}
