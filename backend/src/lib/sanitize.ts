/**
 * Input sanitization utilities for preventing XSS and injection attacks.
 *
 * Provides:
 * - HTML sanitization (strip/escape markup)
 * - Length limiting for text fields
 * - SQL injection prevention (handled by parameterized queries)
 */

// Maximum lengths for various text fields
export const TEXT_LIMITS = {
  MARKET_QUESTION: 500,
  MARKET_DESCRIPTION: 2000, // If we add description field later
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
 * Escape HTML special characters to prevent XSS.
 * This is a safe, minimal escape function - for richer content use DOMPurify.
 */
export function escapeHtml(input: string): string {
  return input.replace(/[&<>"'`=/]/g, (char) => HTML_ENTITIES[char] ?? char);
}

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

/**
 * Sanitize a user display name.
 * - Max 50 characters
 * - No HTML/markup
 * - Single line
 */
export function sanitizeDisplayName(input: unknown): string | null {
  if (input === null || input === undefined) {
    return null;
  }
  const text = sanitizeText(input, TEXT_LIMITS.USER_DISPLAY_NAME, false);
  return text || null;
}

/**
 * Audit existing stored content for potential XSS vectors.
 * Scans database rows for HTML tags, script content, etc.
 */
export interface AuditFinding {
  table: string;
  column: string;
  id: string | number;
  issue: string;
  snippet: string;
}

export async function auditStoredContent(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];

  // Check markets.question for HTML tags
  const marketQuestions = await db.query(
    `SELECT id, question FROM markets WHERE question ~ '<[^>]+>'`
  );
  for (const row of marketQuestions.rows) {
    findings.push({
      table: "markets",
      column: "question",
      id: row.id,
      issue: "Contains HTML/XML tags",
      snippet: row.question.slice(0, 100),
    });
  }

  // Check markets.category for HTML tags
  const marketCategories = await db.query(
    `SELECT id, category FROM markets WHERE category ~ '<[^>]+>'`
  );
  for (const row of marketCategories.rows) {
    findings.push({
      table: "markets",
      column: "category",
      id: row.id,
      issue: "Contains HTML/XML tags",
      snippet: row.category.slice(0, 100),
    });
  }

  // Check markets.image_url for javascript: or data: URLs
  const marketImages = await db.query(
    `SELECT id, image_url FROM markets WHERE image_url ~* '^(javascript|data):'`
  );
  for (const row of marketImages.rows) {
    findings.push({
      table: "markets",
      column: "image_url",
      id: row.id,
      issue: "Potentially dangerous URL scheme",
      snippet: row.image_url.slice(0, 100),
    });
  }

  // Check leaderboard.display_name for HTML tags
  const displayNames = await db.query(
    `SELECT address, display_name FROM leaderboard WHERE display_name ~ '<[^>]+>'`
  );
  for (const row of displayNames.rows) {
    findings.push({
      table: "leaderboard",
      column: "display_name",
      id: row.address,
      issue: "Contains HTML/XML tags",
      snippet: row.display_name.slice(0, 100),
    });
  }

  return findings;
}

/**
 * Sanitize output for safe rendering in HTML contexts.
 * This is a defense-in-depth measure - input should already be sanitized.
 */
export function sanitizeForHtmlOutput(input: string): string {
  return escapeHtml(input);
}

/**
 * Sanitize output for safe rendering in JSON contexts.
 * JSON.stringlify handles this, but this ensures no raw control chars.
 */
export function sanitizeForJsonOutput(input: unknown): string {
  if (input === null || input === undefined) return "";
  return String(input).replace(/[\x00-\x1F\x7F]/g, "");
}
