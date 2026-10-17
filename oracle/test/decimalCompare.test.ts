import { test, expect } from "vitest";
import { compareDecimal, exceedsThreshold, belowThreshold } from "../src/adapters/decimalCompare.js";

test('handles floating point boundary case', () => {
  // 0.1 + 0.2 = 0.30000000000000004 in binary float
  expect(compareDecimal('0.3', 0.3, '==')).toBe(true);
  expect(compareDecimal('0.30000000000000004', 0.3, '==')).toBe(false);
});

test('preserves provider precision', () => {
  expect(compareDecimal('12345.6789', 12345.6789, '==')).toBe(true);
  expect(exceedsThreshold('12345.6790', 12345.6789)).toBe(true);
  expect(belowThreshold('12345.6788', 12345.6789)).toBe(true);
});
