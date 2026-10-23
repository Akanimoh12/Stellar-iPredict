#!/usr/bin/env node
/**
 * Audit script for stored content sanitization (issue #601).
 *
 * Scans the database for potential XSS vectors in text fields:
 * - markets.question
 * - markets.category
 * - markets.image_url
 * - leaderboard.display_name
 *
 * Usage: npx tsx scripts/audit-sanitization.ts
 */

import { Pool, types } from "pg";
import { auditStoredContent, type AuditFinding } from "../backend/src/lib/sanitize.js";

// Ensure numeric types are returned as strings
types.setTypeParser(types.builtins.NUMERIC, (val: string) => val);

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL environment variable is required");
    process.exit(1);
  }

  const pool = new Pool({ connectionString });

  const db = {
    query: async (text: string, params?: unknown[]) => {
      const result = await pool.query(text, params);
      return { rows: result.rows };
    },
  };

  console.log("🔍 Auditing stored content for XSS vectors...\n");

  const findings = await auditStoredContent(db);

  await pool.end();

  if (findings.length === 0) {
    console.log("✅ No XSS vectors found in stored content.");
    process.exit(0);
  }

  console.log(`⚠️  Found ${findings.length} potential issue(s):\n`);

  for (const finding of findings) {
    console.log(`  Table: ${finding.table}`);
    console.log(`  Column: ${finding.column}`);
    console.log(`  ID: ${finding.id}`);
    console.log(`  Issue: ${finding.issue}`);
    console.log(`  Snippet: ${finding.snippet}`);
    console.log("");
  }

  console.log("📋 Recommendation: Run a migration to sanitize these fields.");
  console.log("   See backend/src/lib/sanitize.ts for sanitization functions.");

  process.exit(1);
}

main().catch((err) => {
  console.error("Audit failed:", err);
  process.exit(1);
});