import { describe, it, expect } from "vitest";
import { validateResponseAgainstSpec, detectDroppedFields } from "./contract-helpers.js";
describe("Contract helpers", () => {
  it("detects nested omissions, array items, null and ignores undefined", () => {
    expect(detectDroppedFields({ markets: [{ id: "1", extra: true }], absent: undefined }, { markets: [{ id: "1" }] }).droppedFields).toEqual(["markets[0].extra"]);
    expect(detectDroppedFields({ nested: { id: 1 } }, { nested: null }).droppedFields).toEqual(["nested.id"]);
    expect(detectDroppedFields({ id: 1 }, null).droppedFields).toEqual(["id"]);
  });
  it("does not accept inherited properties as serialized fields", () => {
    expect(detectDroppedFields({ toString: "value" }, {}).droppedFields).toEqual(["toString"]);
  });
  const spec = { paths: { "/example": { get: { responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Example" } } } } } } } }, components: { schemas: {
    Example: { type: "object", required: ["child"], properties: { child: { $ref: "#/components/schemas/Child" } } },
    Child: { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string" } } },
  } } };
  it("resolves component references including nested references on repeated calls", () => {
    for (let i = 0; i < 2; i++) expect(validateResponseAgainstSpec(spec, "GET", "/example", 200, { child: { id: "1" } }).valid).toBe(true);
    expect(validateResponseAgainstSpec(spec, "GET", "/example", 200, { child: {} }).valid).toBe(false);
    expect(validateResponseAgainstSpec(spec, "GET", "/example", 200, { child: { id: 1 } }).valid).toBe(false);
  });
  it("rejects undocumented paths and statuses", () => {
    expect(validateResponseAgainstSpec(spec, "GET", "/missing", 200, {}).schemaFound).toBe(false);
    expect(validateResponseAgainstSpec(spec, "GET", "/example", 201, {}).schemaFound).toBe(false);
  });
});
