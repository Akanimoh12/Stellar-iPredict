#!/usr/bin/env node

/**
 * Audit script to identify oracle submissions with zero bond amounts.
 * This helps track pre-existing data issues before enforcing bond validation.
 * 
 * Run with: npx tsx scripts/audit-zero-bonds.ts
 */

import { Pool } from "pg";
import { config } from "../backend/src/config/index.js";

interface ZeroBondRow {
  id: number;
  market_id: number;
  submitter: string;
  outcome: string;
  bond_amount: string;
  submitted_at: string;
  status: string;
}

async function auditZeroBonds() {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
  });

  try {
    console.log("🔍 Auditing oracle_submissions for zero bond amounts...\n");

    const result = await pool.query<ZeroBondRow>(
      `SELECT id, market_id, submitter, outcome, bond_amount, submitted_at, status
       FROM oracle_submissions
       WHERE bond_amount = '0' OR bond_amount = '0.0000000' OR bond_amount = ''
       ORDER BY submitted_at DESC`
    );

    const zeroBondRows = result.rows;

    if (zeroBondRows.length === 0) {
      console.log("✅ No zero-bond submissions found. Database is clean!");
      return;
    }

    console.log(`⚠️  Found ${zeroBondRows.length} submission(s) with zero/empty bond:\n`);
    console.log("ID\tMarket\tSubmitter\tOutcome\tBond\tSubmitted");
    console.log("─".repeat(100));

    for (const row of zeroBondRows) {
      console.log(
        `${row.id}\t${row.market_id}\t${row.submitter.slice(0, 10)}...\t${row.outcome}\t${row.bond_amount}\t${row.submitted_at}`
      );
    }

    console.log("\n📊 Summary:");
    console.log(`   Total zero-bond submissions: ${zeroBondRows.length}`);

    // Group by market
    const markets = new Set(zeroBondRows.map(r => r.market_id));
    console.log(`   Affected markets: ${markets.size}`);

    // Group by submitter
    const submitters = new Set(zeroBondRows.map(r => r.submitter));
    console.log(`   Unique submitters: ${submitters.size}`);

    console.log("\n💡 Recommendation:");
    console.log("   These submissions were recorded before bond validation was enforced.");
    console.log("   Consider investigating why bonds were not recorded properly.");

  } catch (error) {
    console.error("❌ Error running audit:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

auditZeroBonds().catch(console.error);