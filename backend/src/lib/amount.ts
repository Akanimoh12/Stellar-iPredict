const DECIMAL_PLACES = 7;
const STROOPS_PER_XLM_BIGINT = 10_000_000n;

/** Number of stroops in one XLM. */
export const STROOPS_PER_XLM = 10_000_000;

export type AmountInput = bigint | number | string;

function normalizeIntegerInput(value: AmountInput, name: string): bigint {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`${name} must be a safe integer`);
    }

    return BigInt(value);
  }

  if (!/^\d+$/.test(value)) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }

  return BigInt(value);
}

/**
 * Converts a stroop amount to XLM using a fixed seven-decimal representation.
 *
 * Strings are used deliberately so the conversion does not lose precision.
 * For example, 1 stroop is represented as `0.0000001`.
 */
export function stroopsToXlm(stroops: AmountInput): string {
  const amount = normalizeIntegerInput(stroops, "stroops");

  if (amount < 0n) {
    throw new RangeError("stroops must be non-negative");
  }

  const whole = amount / STROOPS_PER_XLM_BIGINT;
  const fraction = (amount % STROOPS_PER_XLM_BIGINT)
    .toString()
    .padStart(DECIMAL_PLACES, "0");

  return `${whole}.${fraction}`;
}

/**
 * Converts an XLM amount to stroops exactly.
 *
 * XLM values must contain no more than seven decimal places. Rounding is not
 * performed because silently changing a payment amount is unsafe.
 */
export function xlmToStroops(xlm: AmountInput): bigint {
  let text: string;

  if (typeof xlm === "number") {
    if (!Number.isFinite(xlm) || Math.abs(xlm) > Number.MAX_SAFE_INTEGER) {
      throw new TypeError(
        "xlm must be a non-negative decimal with at most 7 decimal places"
      );
    }

    text = xlm.toFixed(DECIMAL_PLACES);
    if (Number(text) !== xlm) {
      throw new TypeError(
        "xlm must be a non-negative decimal with at most 7 decimal places"
      );
    }
  } else {
    text = typeof xlm === "bigint" ? xlm.toString() : xlm;
  }

  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(text);

  if (!match) {
    throw new TypeError("xlm must be a non-negative decimal with at most 7 decimal places");
  }

  const whole = BigInt(match[1]);
  const fraction = (match[2] ?? "").padEnd(DECIMAL_PLACES, "0");

  return whole * STROOPS_PER_XLM_BIGINT + BigInt(fraction || "0");
}

/**
 * Adds two XLM amount representations exactly without converting to floating-point numbers.
 * The result is formatted as a fixed seven-decimal string.
 */
export function addXlmAmounts(a: AmountInput, b: AmountInput): string {
  const stroopsA = xlmToStroops(a);
  const stroopsB = xlmToStroops(b);
  return stroopsToXlm(stroopsA + stroopsB);
}

/**
 * Ensures the PostgreSQL client driver returns NUMERIC columns (OID 1700)
 * as raw strings rather than parsing them into lossy JavaScript numbers.
 */
export function configurePgNumericParser(pgTypes: {
  setTypeParser: (oid: number, fn: (val: string) => unknown) => void;
  builtins?: { NUMERIC: number };
}): void {
  const numericOid = pgTypes.builtins?.NUMERIC ?? 1700;
  pgTypes.setTypeParser(numericOid, (val: string) => val);
}

/**
 * Converts XLM to a JavaScript number of stroops when the result is safe.
 * @deprecated Use xlmToStroops for amounts that may exceed Number.MAX_SAFE_INTEGER.
 * Any amount path that converts through a JS number can silently lose precision on large values.
 */
export function xlmToStroopsNumber(xlm: AmountInput): number {
  const stroops = xlmToStroops(xlm);

  if (stroops > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("stroop amount exceeds Number.MAX_SAFE_INTEGER");
  }

  return Number(stroops);
}

