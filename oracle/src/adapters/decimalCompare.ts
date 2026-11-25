/**
 * Decimal-Safe Threshold Comparisons (Issue #568)
 * 
 * Avoids floating point representation errors in threshold comparisons.
 * Preserves provider's original decimal string precision.
 */

export class InvalidPriceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPriceError";
  }
}

/**
 * Validates that a price string represents a finite, non-negative decimal value.
 * Rejects "NaN", "Infinity", "-Infinity", negative prices, or non-numeric strings.
 */
export function validatePriceString(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidPriceError(
      `Invalid price: expected non-empty string, received ${typeof value === "string" ? '""' : typeof value}`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("-")) {
    throw new InvalidPriceError(
      `Invalid price: negative price values are not permitted (received "${value}")`,
    );
  }
  const num = Number(trimmed);
  if (!Number.isFinite(num) || Number.isNaN(num) || num < 0) {
    throw new InvalidPriceError(
      `Invalid price: expected finite non-negative number, received "${value}"`,
    );
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new InvalidPriceError(`Invalid price: malformed decimal format "${value}"`);
  }
}

/**
 * Validates that a threshold is a finite, non-negative number.
 */
export function validateThreshold(threshold: number): void {
  if (
    typeof threshold !== "number" ||
    !Number.isFinite(threshold) ||
    Number.isNaN(threshold) ||
    threshold < 0
  ) {
    throw new InvalidPriceError(
      `Invalid threshold: expected finite non-negative number, received ${threshold}`,
    );
  }
}

/**
 * Compare decimal strings without floating point conversion
 * 
 * @param value - Decimal string from provider
 * @param threshold - Decimal threshold
 * @param operator - Comparison operator
 * @returns true if comparison holds
 */
export function compareDecimal(
  value: string,
  threshold: number,
  operator: '>' | '<' | '>=' | '<=' | '==' | '!='
): boolean {
  validatePriceString(value);
  validateThreshold(threshold);

  const trimmed = value.trim();
  // Parse to BigInt by removing decimal point and tracking scale
  const valueParts = trimmed.split('.');
  const valueInt = valueParts[0] + (valueParts[1] || '');
  const valueScale = valueParts[1]?.length || 0;
  
  const thresholdStr = threshold.toFixed(Math.max(valueScale, 8));
  const thresholdParts = thresholdStr.split('.');
  const thresholdInt = thresholdParts[0] + (thresholdParts[1] || '');
  const thresholdScale = thresholdParts[1]?.length || 0;
  
  // Normalize to same scale
  const maxScale = Math.max(valueScale, thresholdScale);
  const normalizedValue = BigInt(valueInt.padEnd(valueInt.length + (maxScale - valueScale), '0'));
  const normalizedThreshold = BigInt(thresholdInt.padEnd(thresholdInt.length + (maxScale - thresholdScale), '0'));
  
  switch (operator) {
    case '>': return normalizedValue > normalizedThreshold;
    case '<': return normalizedValue < normalizedThreshold;
    case '>=': return normalizedValue >= normalizedThreshold;
    case '<=': return normalizedValue <= normalizedThreshold;
    case '==': return normalizedValue === normalizedThreshold;
    case '!=': return normalizedValue !== normalizedThreshold;
  }
}

/**
 * Check if price exceeds threshold (decimal-safe)
 */
export function exceedsThreshold(priceStr: string, threshold: number): boolean {
  return compareDecimal(priceStr, threshold, '>');
}

/**
 * Check if price is below threshold (decimal-safe)
 */
export function belowThreshold(priceStr: string, threshold: number): boolean {
  return compareDecimal(priceStr, threshold, '<');
}
