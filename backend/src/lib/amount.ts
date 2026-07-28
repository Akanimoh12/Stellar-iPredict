export const STROOPS_PER_XLM = 10_000_000n;
export const XLM_DECIMAL_PLACES = 7;

type AmountInput = bigint | number | string;

function parseStroops(value: AmountInput): bigint {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError("stroops must be a safe integer");
    }

    return BigInt(value);
  }

  if (!/^[+-]?\d+$/.test(value)) {
    throw new TypeError("stroops must be an integer");
  }

  return BigInt(value);
}

/**
 * Converts a stroop amount to an XLM decimal string.
 *
 * The returned value always contains exactly seven decimal places, matching
 * Stellar's native precision without introducing floating-point rounding.
 */
export function stroopsToXlm(stroops: AmountInput): string {
  const amount = parseStroops(stroops);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const whole = absolute / STROOPS_PER_XLM;
  const fraction = (absolute % STROOPS_PER_XLM).toString().padStart(XLM_DECIMAL_PLACES, "0");
  const result = `${whole}.${fraction}`;

  return negative && absolute !== 0n ? `-${result}` : result;
}

/**
 * Converts an XLM decimal amount to stroops without using floating point.
 *
 * XLM values may contain at most seven digits after the decimal point. The
 * result is a bigint so amounts larger than Number.MAX_SAFE_INTEGER remain
 * exact.
 */
export function xlmToStroops(xlm: AmountInput): bigint {
  const text = typeof xlm === "number" ? String(xlm) : xlm.toString();

  if (typeof xlm === "number" && !Number.isFinite(xlm)) {
    throw new TypeError("XLM amount must be finite");
  }

  if (!/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))$/.test(text)) {
    throw new TypeError("XLM amount must be a decimal number");
  }

  const negative = text.startsWith("-");
  const unsigned = text.replace(/^[+-]/, "");
  const [wholePart, fractionPart = ""] = unsigned.split(".");

  if (fractionPart.length > XLM_DECIMAL_PLACES) {
    throw new RangeError(`XLM amount cannot have more than ${XLM_DECIMAL_PLACES} decimal places`);
  }

  const whole = BigInt(wholePart || "0");
  const fraction = BigInt(fractionPart.padEnd(XLM_DECIMAL_PLACES, "0") || "0");
  const result = whole * STROOPS_PER_XLM + fraction;

  return negative && result !== 0n ? -result : result;
}
