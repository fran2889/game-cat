import { ERROR_CODES } from "../shared/types.ts";
import { HttpError } from "./errors.ts";

/**
 * The request-parsing primitives shared by every route: one validation-error
 * builder and one not-found helper. Behaviour is fixed by spec §4.3 and the
 * contract suite, so a route cannot grow its own variant.
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

/** The documented 404 envelope, carrying the identifier the caller supplied. */
export function notFound(identifier: string, resource = "resource"): HttpError {
  return new HttpError(404, ERROR_CODES.notFound, `The requested ${resource} was not found.`, {
    details: { id: identifier },
  });
}
