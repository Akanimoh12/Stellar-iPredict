#!/usr/bin/env tsx
/**
 * Mutation testing runner for critical Oracle aggregator modules.
 * Assesses assertion quality in financial and consensus modules (threshold & bond reconciliation).
 *
 * Usage:
 *   npx tsx scripts/mutation-runner.ts
 *   npx tsx scripts/mutation-runner.ts --bail
 *   npx tsx scripts/mutation-runner.ts --target=90
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const oracleRoot = path.resolve(__dirname, "..");

export interface MutantDefinition {
  id: string;
  category: "boundary" | "arithmetic" | "logical" | "conditional" | "statement" | "assignment";
  description: string;
  file: string;
  testFile: string;
  find: string;
  replace: string;
}

export interface MutantResult {
  mutant: MutantDefinition;
  status: "killed" | "survived" | "error";
  durationMs: number;
  outputSnippet?: string;
}

export const TARGET_MUTATION_SCORE = 90; // 90% target for critical modules

export const MUTANTS: MutantDefinition[] = [
  // ==========================================
  // threshold.ts mutants
  // ==========================================
  {
    id: "TH-01",
    category: "boundary",
    description: "Relax non-positive threshold check from <= 0 to < 0 (permits threshold 0)",
    file: "src/aggregator/threshold.ts",
    testFile: "test/threshold.test.ts",
    find: "threshold <= 0",
    replace: "threshold < 0",
  },
  {
    id: "TH-02",
    category: "conditional",
    description: "Bypass integer check on threshold (permits floats)",
    file: "src/aggregator/threshold.ts",
    testFile: "test/threshold.test.ts",
    find: "!Number.isInteger(threshold)",
    replace: "false",
  },
  {
    id: "TH-03",
    category: "statement",
    description: "Do not trim member identifiers",
    file: "src/aggregator/threshold.ts",
    testFile: "test/threshold.test.ts",
    find: "const member = vote.member.trim();",
    replace: "const member = vote.member;",
  },
  {
    id: "TH-04",
    category: "conditional",
    description: "Allow blank member identifiers into vote map",
    file: "src/aggregator/threshold.ts",
    testFile: "test/threshold.test.ts",
    find: "if (member) votesByMember.set(member, vote.outcome);",
    replace: "votesByMember.set(member, vote.outcome);",
  },
  {
    id: "TH-05",
    category: "arithmetic",
    description: "Invert tally counter increment logic (increment no on outcome true)",
    file: "src/aggregator/threshold.ts",
    testFile: "test/threshold.test.ts",
    find: "if (outcome) yes += 1;",
    replace: "if (outcome) no += 1;",
  },
  {
    id: "TH-06",
    category: "boundary",
    description: "Mutate yes threshold boundary from >= to > (strictly greater)",
    file: "src/aggregator/threshold.ts",
    testFile: "test/threshold.test.ts",
    find: "const yesReached = yes >= threshold;",
    replace: "const yesReached = yes > threshold;",
  },
  {
    id: "TH-07",
    category: "boundary",
    description: "Mutate yes threshold boundary from >= to === (exact match only)",
    file: "src/aggregator/threshold.ts",
    testFile: "test/threshold.test.ts",
    find: "const yesReached = yes >= threshold;",
    replace: "const yesReached = yes === threshold;",
  },
  {
    id: "TH-08",
    category: "boundary",
    description: "Mutate no threshold boundary from >= to > (strictly greater)",
    file: "src/aggregator/threshold.ts",
    testFile: "test/threshold.test.ts",
    find: "const noReached = no >= threshold;",
    replace: "const noReached = no > threshold;",
  },
  {
    id: "TH-09",
    category: "boundary",
    description: "Mutate no threshold boundary from >= to === (exact match only)",
    file: "src/aggregator/threshold.ts",
    testFile: "test/threshold.test.ts",
    find: "const noReached = no >= threshold;",
    replace: "const noReached = no === threshold;",
  },
  {
    id: "TH-10",
    category: "logical",
    description: "Mutate ambiguity condition from yesReached === noReached to yesReached && noReached",
    file: "src/aggregator/threshold.ts",
    testFile: "test/threshold.test.ts",
    find: "const ambiguous = yesReached === noReached;",
    replace: "const ambiguous = yesReached && noReached;",
  },
  {
    id: "TH-11",
    category: "conditional",
    description: "Invert ternary selection: return yesReached on ambiguous and null on unambiguous",
    file: "src/aggregator/threshold.ts",
    testFile: "test/threshold.test.ts",
    find: "const result = ambiguous ? null : yesReached;",
    replace: "const result = ambiguous ? yesReached : null;",
  },
  {
    id: "TH-12",
    category: "statement",
    description: "Omit logging vote tally details",
    file: "src/aggregator/threshold.ts",
    testFile: "test/threshold.test.ts",
    find: "logger?.info(\"vote tally\", {",
    replace: "if (false) logger?.info(\"vote tally\", {",
  },
  {
    id: "TH-13",
    category: "assignment",
    description: "Remove null fallback for undefined marketId in logger payload",
    file: "src/aggregator/threshold.ts",
    testFile: "test/threshold.test.ts",
    find: "marketId: marketId ?? null,",
    replace: "marketId: marketId,",
  },

  // ==========================================
  // bond-reconciliation.ts mutants
  // ==========================================
  {
    id: "BR-01",
    category: "conditional",
    description: "Invert settlement membership check in reconcileBonds (!settled -> settled)",
    file: "src/aggregator/bond-reconciliation.ts",
    testFile: "test/bond-reconciliation.test.ts",
    find: "if (!settledMarkets.has(sub.marketId)) {",
    replace: "if (settledMarkets.has(sub.marketId)) {",
  },
  {
    id: "BR-02",
    category: "assignment",
    description: "Zero out expectedAmount in discrepancies",
    file: "src/aggregator/bond-reconciliation.ts",
    testFile: "test/bond-reconciliation.test.ts",
    find: "expectedAmount: sub.bondAmount,",
    replace: "expectedAmount: 0n,",
  },
  {
    id: "BR-03",
    category: "assignment",
    description: "Blank submitter in discrepancies",
    file: "src/aggregator/bond-reconciliation.ts",
    testFile: "test/bond-reconciliation.test.ts",
    find: "submitter: sub.submitter,",
    replace: "submitter: \"\",",
  },
  {
    id: "BR-04",
    category: "assignment",
    description: "Hardcode discrepancy status to finalized (ignoring cancelled/expired)",
    file: "src/aggregator/bond-reconciliation.ts",
    testFile: "test/bond-reconciliation.test.ts",
    find: "status: sub.status,",
    replace: "status: \"finalized\",",
  },
  {
    id: "BR-05",
    category: "assignment",
    description: "Corrupt finalizedAt date in discrepancies",
    file: "src/aggregator/bond-reconciliation.ts",
    testFile: "test/bond-reconciliation.test.ts",
    find: "finalizedAt: sub.finalizedAt,",
    replace: "finalizedAt: new Date(0),",
  },
  {
    id: "BR-06",
    category: "statement",
    description: "Do not execute onDiscrepancy callback in runBondReconciliation",
    file: "src/aggregator/bond-reconciliation.ts",
    testFile: "test/bond-reconciliation.test.ts",
    find: "await onDiscrepancy(d);",
    replace: "// await onDiscrepancy(d);",
  },
  {
    id: "BR-07",
    category: "statement",
    description: "Omit discrepancy warning log in runBondReconciliation",
    file: "src/aggregator/bond-reconciliation.ts",
    testFile: "test/bond-reconciliation.test.ts",
    find: "logger?.warn(\"bond refund discrepancy detected\", {",
    replace: "if (false) logger?.warn(\"bond refund discrepancy detected\", {",
  },
  {
    id: "BR-08",
    category: "statement",
    description: "Omit completion info log in runBondReconciliation",
    file: "src/aggregator/bond-reconciliation.ts",
    testFile: "test/bond-reconciliation.test.ts",
    find: "logger?.info(\"bond reconciliation complete\", {",
    replace: "if (false) logger?.info(\"bond reconciliation complete\", {",
  },
  {
    id: "BR-09",
    category: "conditional",
    description: "Mutate recordSettlement return logic to always return true (bypassing conflict detection)",
    file: "src/aggregator/bond-reconciliation.ts",
    testFile: "test/bond-reconciliation.test.ts",
    find: "return (result.rows.length ?? 0) > 0;",
    replace: "return true;",
  },
  {
    id: "BR-10",
    category: "conditional",
    description: "Mutate recordSettlement return logic to always return false",
    file: "src/aggregator/bond-reconciliation.ts",
    testFile: "test/bond-reconciliation.test.ts",
    find: "return (result.rows.length ?? 0) > 0;",
    replace: "return false;",
  },
  {
    id: "BR-11",
    category: "assignment",
    description: "Swap marketId and recipient parameter bindings in recordSettlement query",
    file: "src/aggregator/bond-reconciliation.ts",
    testFile: "test/bond-reconciliation.test.ts",
    find: "[input.marketId, input.recipient, String(input.settledAmountStroops)]",
    replace: "[input.recipient, input.marketId, String(input.settledAmountStroops)]",
  },
  {
    id: "BR-12",
    category: "assignment",
    description: "Bind zero string for amount in recordSettlement query",
    file: "src/aggregator/bond-reconciliation.ts",
    testFile: "test/bond-reconciliation.test.ts",
    find: "String(input.settledAmountStroops)",
    replace: "\"0\"",
  },
  {
    id: "BR-13",
    category: "assignment",
    description: "Zero out checkedCount in runBondReconciliation summary result",
    file: "src/aggregator/bond-reconciliation.ts",
    testFile: "test/bond-reconciliation.test.ts",
    find: "checkedCount: submissions.length,",
    replace: "checkedCount: 0,",
  },
  {
    id: "BR-14",
    category: "assignment",
    description: "Zero out settledCount in runBondReconciliation summary result",
    file: "src/aggregator/bond-reconciliation.ts",
    testFile: "test/bond-reconciliation.test.ts",
    find: "settledCount: settlements.length,",
    replace: "settledCount: 0,",
  },
  {
    id: "BR-15",
    category: "conditional",
    description: "Narrow SQL status filter in oracle_submissions query to only finalized",
    file: "src/aggregator/bond-reconciliation.ts",
    testFile: "test/bond-reconciliation.test.ts",
    find: "WHERE status IN ('finalized', 'cancelled', 'expired')",
    replace: "WHERE status IN ('finalized')",
  },
];

class OriginalFilesBackup {
  private files = new Map<string, string>();

  backup(filePath: string) {
    if (!this.files.has(filePath)) {
      this.files.set(filePath, fs.readFileSync(filePath, "utf8"));
    }
  }

  restoreAll() {
    for (const [filePath, content] of this.files.entries()) {
      fs.writeFileSync(filePath, content, "utf8");
    }
  }
}

export async function runMutationTesting(): Promise<{
  results: MutantResult[];
  killedCount: number;
  survivedCount: number;
  score: number;
}> {
  const backup = new OriginalFilesBackup();
  const results: MutantResult[] = [];

  // Register clean-up hooks
  const cleanup = () => {
    backup.restoreAll();
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(1); });
  process.on("uncaughtException", (err) => { cleanup(); console.error(err); process.exit(1); });

  console.log(`\n===============================================================`);
  console.log(`  Oracle Package Mutation Testing Runner`);
  console.log(`  Target Modules: threshold.ts, bond-reconciliation.ts`);
  console.log(`  Target Mutation Score: >= ${TARGET_MUTATION_SCORE}%`);
  console.log(`===============================================================\n`);

  for (let i = 0; i < MUTANTS.length; i++) {
    const mutant = MUTANTS[i];
    const targetFilePath = path.join(oracleRoot, mutant.file);
    const testFilePath = mutant.testFile;

    backup.backup(targetFilePath);
    const originalContent = fs.readFileSync(targetFilePath, "utf8");

    if (!originalContent.includes(mutant.find)) {
      console.error(`[ERROR] Pattern for mutant ${mutant.id} not found in ${mutant.file}`);
      results.push({
        mutant,
        status: "error",
        durationMs: 0,
        outputSnippet: `Pattern not found: "${mutant.find}"`,
      });
      continue;
    }

    const mutatedContent = originalContent.replace(mutant.find, mutant.replace);
    fs.writeFileSync(targetFilePath, mutatedContent, "utf8");

    const startTime = Date.now();
    let status: "killed" | "survived" = "survived";
    let outputSnippet = "";

    try {
      execSync(`npx vitest run ${testFilePath}`, {
        cwd: oracleRoot,
        stdio: "pipe",
        timeout: 20000,
      });
      // If execSync exits cleanly with 0, test PASSED -> mutant SURVIVED
      status = "survived";
    } catch (err: unknown) {
      // If execSync throws, test FAILED or timed out -> mutant KILLED
      status = "killed";
      const execErr = err as { stdout?: Buffer; stderr?: Buffer; message?: string };
      outputSnippet = (execErr.stdout?.toString() || execErr.stderr?.toString() || execErr.message || "").slice(0, 300);
    } finally {
      // Always immediately restore original source
      fs.writeFileSync(targetFilePath, originalContent, "utf8");
    }

    const durationMs = Date.now() - startTime;
    results.push({ mutant, status, durationMs, outputSnippet });

    const badge = status === "killed" ? "\x1b[32m[KILLED]\x1b[0m" : "\x1b[31m[SURVIVED]\x1b[0m";
    console.log(`[${i + 1}/${MUTANTS.length}] ${mutant.id.padEnd(6)} ${badge} ${mutant.description} (${durationMs}ms)`);
  }

  const killedCount = results.filter((r) => r.status === "killed").length;
  const survivedCount = results.filter((r) => r.status === "survived").length;
  const score = Math.round((killedCount / results.length) * 100);

  console.log(`\n---------------------------------------------------------------`);
  console.log(`Total Mutants: ${results.length}`);
  console.log(`Killed:        ${killedCount}`);
  console.log(`Survived:      ${survivedCount}`);
  console.log(`Mutation Score: ${score}% (Target: >= ${TARGET_MUTATION_SCORE}%)`);
  console.log(`---------------------------------------------------------------\n`);

  generateReports(results, score, killedCount, survivedCount);

  return { results, killedCount, survivedCount, score };
}

function generateReports(
  results: MutantResult[],
  score: number,
  killedCount: number,
  survivedCount: number,
) {
  const reportsDir = path.join(oracleRoot, "reports");
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  // JSON Report
  const jsonPath = path.join(reportsDir, "mutation-report.json");
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        targetScore: TARGET_MUTATION_SCORE,
        score,
        total: results.length,
        killed: killedCount,
        survived: survivedCount,
        results,
      },
      null,
      2,
    ),
    "utf8",
  );

  // Markdown Report
  const mdPath = path.join(reportsDir, "mutation-report.md");
  let md = `# Oracle Mutation Testing Report\n\n`;
  md += `**Generated:** ${new Date().toISOString()}  \n`;
  md += `**Scope:** Critical Financial & Consensus Modules (\`src/aggregator/threshold.ts\`, \`src/aggregator/bond-reconciliation.ts\`)  \n`;
  md += `**Target Mutation Score:** >= ${TARGET_MUTATION_SCORE}%  \n`;
  md += `**Achieved Mutation Score:** **${score}%** (${killedCount}/${results.length} mutants killed)  \n\n`;

  md += `## Executive Summary\n\n`;
  md += `Mutation testing verifies that test assertions are capable of detecting synthetic bugs, guarding against untested execution paths and regressions in critical financial workflows.\n\n`;
  md += `| Metric | Value |\n`;
  md += `| :--- | :--- |\n`;
  md += `| **Total Mutants Evaluated** | ${results.length} |\n`;
  md += `| **Mutants Killed** | ${killedCount} |\n`;
  md += `| **Mutants Survived** | ${survivedCount} |\n`;
  md += `| **Mutation Score** | **${score}%** |\n`;
  md += `| **Target Score Threshold** | ${TARGET_MUTATION_SCORE}% |\n`;
  md += `| **Status** | ${score >= TARGET_MUTATION_SCORE ? "PASSED" : "FAILED"} |\n\n`;

  md += `## Detailed Mutant Results\n\n`;
  md += `| ID | File | Category | Description | Status |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- |\n`;
  for (const r of results) {
    const statusIcon = r.status === "killed" ? "KILLED" : "**SURVIVED**";
    md += `| ${r.mutant.id} | \`${r.mutant.file}\` | ${r.mutant.category} | ${r.mutant.description} | ${statusIcon} |\n`;
  }

  if (survivedCount > 0) {
    md += `\n### Surviving Mutants Details\n\n`;
    for (const r of results.filter((res) => res.status === "survived")) {
      md += `#### ${r.mutant.id}: ${r.mutant.description}\n`;
      md += `- **File:** \`${r.mutant.file}\`\n`;
      md += `- **Original Code:**\n\`\`\`ts\n${r.mutant.find}\n\`\`\`\n`;
      md += `- **Mutated Code:**\n\`\`\`ts\n${r.mutant.replace}\n\`\`\`\n`;
      md += `- **Recommendation:** Add explicit assertions in \`${r.mutant.testFile}\` to catch this bug.\n\n`;
    }
  }

  md += `\n## Target Score Rationale\n\n`;
  md += `A target mutation score of **${TARGET_MUTATION_SCORE}%** is established for the oracle's consensus and settlement modules. Because bond refund reconciliation and vote threshold aggregation manage economic value and protocol finality, test suites must verify exact boundaries, object payloads, and error conditions rather than merely executing code paths.\n`;

  fs.writeFileSync(mdPath, md, "utf8");
  console.log(`Saved mutation report to ${path.relative(oracleRoot, mdPath)} and ${path.relative(oracleRoot, jsonPath)}`);
}

// Direct execution
if (process.argv[1] === __filename) {
  runMutationTesting().then(({ score }) => {
    if (score < TARGET_MUTATION_SCORE) {
      console.warn(`[WARNING] Mutation score ${score}% is below target ${TARGET_MUTATION_SCORE}%.`);
      if (process.argv.includes("--bail")) {
        process.exit(1);
      }
    }
  });
}
