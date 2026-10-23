/**
 * Input sanitization utilities for preventing XSS and injection attacks.
 * Shared with backend/src/lib/sanitize.ts - keep in sync.
 */

// Maximum lengths for various text fields
export const TEXT_LIMITS = {
  MARKET_QUESTION: 500,
  MARKET_DESCRIPTION: 2000,
  MARKET_CATEGORY: 50,
  MARKET_IMAGE_URL: 2048,
  USER_DISPLAY_NAME: 50,
  GENERIC_SHORT: 100,
  GENERIC_MEDIUM: 500,
  GENERIC_LONG: 5000,
} as const;

/**
 * HTML entity encoding map.
 */
const HTML_ENTITIES: Record<string, string> = {
  "&": "\u0026amp;",
  "<": "\u0026lt;",
  ">": "\u0026gt;",
  '"': "\u0026quot;",
  "'": "\u0026#39;",
  "/": "\u0026#x2F;",
  "`": "\u0026#x60;",
  "=": "\u0026#x3D;",
};

/**
 * Strip all HTML/XML tags from input.
 * More aggressive than escaping - removes tags entirely.
 */
export function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, "");
}

/**
 * Sanitize a text field for safe storage and display.
 *
 * Applies:
 * 1. Trimming whitespace
 * 2. Length limiting
 * 3. HTML tag stripping (prevents stored XSS)
 * 4. Control character removal (except newlines/tabs)
 *
 * @param input - Raw input string
 * @param maxLength - Maximum allowed length (after trimming)
 * @param allowNewlines - Whether to preserve newlines (default: false)
 * @returns Sanitized string
 */
export function sanitizeText(
  input: unknown,
  maxLength: number,
  allowNewlines = false
): string {
  if (input === null || input === undefined) {
    return "";
  }

  let text = String(input).trim();

  // Remove control characters except newline and tab
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  // Strip HTML/XML tags
  text = stripTags(text);

  // Limit length
  if (text.length > maxLength) {
    text = text.slice(0, maxLength);
  }

  // Normalize whitespace if not allowing newlines
  if (!allowNewlines) {
    text = text.replace(/\s+/g, " ").trim();
  }

  return text;
}

/**
 * Sanitize a market question.
 * - Max 500 characters
 * - No HTML/markup
 * - Single line (no newlines)
 */
export function sanitizeMarketQuestion(input: unknown): string {
  return sanitizeText(input, TEXT_LIMITS.MARKET_QUESTION, false);
}

/**
 * Sanitize a market category.
 * - Max 50 characters
 * - No HTML/markup
 * - Single line
 */
export function sanitizeMarketCategory(input: unknown): string {
  return sanitizeText(input, TEXT_LIMITS.MARKET_CATEGORY, false);
}

/**
 * Sanitize an image URL.
 * - Max 2048 characters
 * - Basic URL validation
 * - No HTML/markup
 */
export function sanitizeImageUrl(input: unknown): string | null {
  if (input === null || input === undefined) {
    return null;
  }
  const text = sanitizeText(input, TEXT_LIMITS.MARKET_IMAGE_URL, false);
  if (!text) return null;

  // Basic URL validation - must start with http:// or https://
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return text;
  } catch {
    return null;
  }
}
