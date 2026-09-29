/**
 * Decimal-Safe Threshold Comparisons (Issue #568)
 * 
 * Avoids floating point representation errors in threshold comparisons.
 * Preserves provider's original decimal string precision.
 */

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
  // Parse to BigInt by removing decimal point and tracking scale
  const valueParts = value.split('.');
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

// Test cases for floating point representation errors
if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;
  
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
}
