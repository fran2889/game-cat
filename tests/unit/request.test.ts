import { describe, expect, it } from "vitest";
import { asRecord, notFound, parseInteger, validationError } from "../../src/server/request.ts";

describe("parseInteger", () => {
  it("returns the fallback for an absent or empty value without an error", () => {
    for (const value of [undefined, ""]) {
      const fieldErrors: Record<string, string> = {};
      expect(parseInteger(value, 7, "page", 1, 100, fieldErrors)).toBe(7);
      expect(fieldErrors).toEqual({});
    }
  });

  it("returns the fallback and records one error for a rejected value", () => {
    for (const value of ["abc", "-1", "1.5", "0", "101"]) {
      const fieldErrors: Record<string, string> = {};
      expect(parseInteger(value, 7, "page", 1, 100, fieldErrors)).toBe(7);
      expect(fieldErrors).toEqual({ page: "must be an integer between 1 and 100" });
    }
  });

  it("accepts the inclusive bounds", () => {
    for (const value of ["1", "100"]) {
      const fieldErrors: Record<string, string> = {};
      expect(parseInteger(value, 7, "page", 1, 100, fieldErrors)).toBe(Number(value));
      expect(fieldErrors).toEqual({});
    }
  });
});

describe("asRecord", () => {
  it("narrows plain objects and rejects everything else", () => {
    expect(asRecord({ value: 1 })).toEqual({ value: 1 });
    for (const value of [null, undefined, [], "text", 1, true]) {
      expect(asRecord(value)).toBeNull();
    }
  });
});

describe("validationError", () => {
  it("defaults to the query envelope and names the body subject on request", () => {
    expect(validationError({ page: "bad" })).toMatchObject({
      statusCode: 422,
      code: "VALIDATION_ERROR",
      message: "Request query is invalid",
      details: { fieldErrors: { page: "bad" } },
    });
    expect(validationError({ name: "bad" }, "body")).toMatchObject({
      statusCode: 422,
      code: "VALIDATION_ERROR",
      message: "Request body is invalid",
      details: { fieldErrors: { name: "bad" } },
    });
  });
});

describe("notFound", () => {
  it("carries the identifier and the resource name", () => {
    expect(notFound("42")).toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
      details: { id: "42" },
    });
    expect(notFound("abc", "Smart Collection")).toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
      message: "The requested Smart Collection was not found.",
      details: { id: "abc" },
    });
  });
});
