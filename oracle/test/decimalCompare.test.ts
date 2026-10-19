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

test('rejects negative price values', () => {
  expect(() => compareDecimal('-100', 50, '>')).toThrow('negative price values are not permitted');
  expect(() => exceedsThreshold('-0.0001', 0)).toThrow('negative price values are not permitted');
  expect(() => belowThreshold('-50000', 100)).toThrow('negative price values are not permitted');
});

test('rejects non-finite and malformed price strings', () => {
  expect(() => compareDecimal('NaN', 100, '==')).toThrow('expected finite non-negative number');
  expect(() => compareDecimal('Infinity', 100, '>')).toThrow('expected finite non-negative number');
  expect(() => compareDecimal('-Infinity', 100, '<')).toThrow('negative price values are not permitted');
  expect(() => compareDecimal('abc', 100, '>')).toThrow('expected finite non-negative number');
  expect(() => compareDecimal('', 100, '>')).toThrow('expected non-empty string');
});

test('rejects invalid or negative thresholds', () => {
  expect(() => compareDecimal('100', -1, '>')).toThrow('expected finite non-negative number');
  expect(() => compareDecimal('100', NaN, '>')).toThrow('expected finite non-negative number');
  expect(() => compareDecimal('100', Infinity, '>')).toThrow('expected finite non-negative number');
});
