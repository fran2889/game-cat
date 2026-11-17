import { describe, expect, it } from "vitest";
import { notFound, validationError } from "../../src/server/request.ts";

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
