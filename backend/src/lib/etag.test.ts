import { describe, expect, it } from "vitest";

import { computeEtag, matchesIfNoneMatch } from "./etag";

describe("computeEtag", () => {
  it("is a quoted hex digest", () => {
    const etag = computeEtag({ a: 1 });
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/);
  });

  it("is stable for the same payload", () => {
    expect(computeEtag({ a: 1, b: [1, 2, 3] })).toBe(
      computeEtag({ a: 1, b: [1, 2, 3] })
    );
  });

  it("differs when the payload changes", () => {
    expect(computeEtag({ a: 1 })).not.toBe(computeEtag({ a: 2 }));
  });
});

describe("matchesIfNoneMatch", () => {
  const etag = '"abc123"';

  it("returns false when the header is absent", () => {
    expect(matchesIfNoneMatch(undefined, etag)).toBe(false);
  });

  it("matches an exact value", () => {
    expect(matchesIfNoneMatch(etag, etag)).toBe(true);
  });

  it("matches one entry in a comma-separated list", () => {
    expect(matchesIfNoneMatch(`"other", ${etag}`, etag)).toBe(true);
  });

  it("matches the wildcard", () => {
    expect(matchesIfNoneMatch("*", etag)).toBe(true);
  });

  it("returns false when nothing matches", () => {
    expect(matchesIfNoneMatch('"other"', etag)).toBe(false);
  });
});
