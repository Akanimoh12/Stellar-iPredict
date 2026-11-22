#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const ALLOWED_LICENSES = new Set([
  "MIT",
  "Apache-2.0",
  "Apache 2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSD",
  "ISC",
  "0BSD",
  "CC0-1.0",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "Unlicense",
  "WTFPL",
  "Python-2.0",
  "BlueOak-1.0.0",
  "MPL-2.0",
  "LGPL-3.0-or-later",
  "LGPL-3.0-only",
]);

// Explicit exceptions for known transitive dependencies in wallet/Next.js toolchains
const APPROVED_PACKAGES = new Set([
  "@lobstrco/signer-extension-api", // Stellar wallet kit provider
  "ua-parser-js", // Transitive web utility
]);

function isAllowed(pkgName, licenseStr) {
  if (APPROVED_PACKAGES.has(pkgName)) return true;
  if (!licenseStr) return false;

  const clean = String(licenseStr).replace(/[()]/g, "").trim();
  if (ALLOWED_LICENSES.has(clean)) return true;

  if (clean.toLowerCase().includes("see license in license.md") || clean.toLowerCase().includes("see license.md")) {
    // Trezor suite packages under Apache-2.0 in trezor-suite monorepo
    if (pkgName.startsWith("@trezor/")) return true;
  }

  // Split OR/AND expressions
  const parts = clean.split(/\s+(?:OR|AND)\s+/i);
  if (parts.length > 1) {
    return parts.some((p) => ALLOWED_LICENSES.has(p.trim()));
  }

  return false;
}

function normalizePkgName(pkgPath) {
  const parts = pkgPath.split("node_modules/");
  return parts[parts.length - 1];
}

function auditLockfile(lockfilePath) {
  if (!fs.existsSync(lockfilePath)) {
    return { total: 0, violations: [] };
  }

  const raw = fs.readFileSync(lockfilePath, "utf-8");
  const data = JSON.parse(raw);
  const packages = data.packages || {};

  let total = 0;
  const violations = [];

  for (const [pkgPath, info] of Object.entries(packages)) {
    if (!pkgPath || pkgPath === "") continue;
    if (info.dev) continue;
    total++;

    const pkgName = normalizePkgName(pkgPath);
    const license = info.license;
    if (!license) continue;

    const licenseStr = typeof license === "string" ? license : license.type;
    if (!isAllowed(pkgName, licenseStr)) {
      violations.push({ pkg: pkgName, license: licenseStr });
    }
  }

  return { total, violations };
}

function main() {
  console.log("🔍 Auditing dependency licenses against allowed permissive policies...");

  const lockfiles = [
    path.join(process.cwd(), "package-lock.json"),
    path.join(process.cwd(), "frontend", "package-lock.json"),
  ];

  let anyViolations = false;

  for (const lf of lockfiles) {
    if (!fs.existsSync(lf)) continue;
    console.log(`Checking ${path.relative(process.cwd(), lf)}...`);
    const { total, violations } = auditLockfile(lf);
    console.log(`  Checked ${total} production dependencies.`);

    if (violations.length > 0) {
      console.error(`  ❌ Found ${violations.length} licenses needing review:`);
      for (const v of violations) {
        console.error(`    - ${v.pkg}: ${v.license}`);
      }
      anyViolations = true;
    } else {
      console.log(`  ✅ All dependency licenses conform to allowed open-source licenses.`);
    }
  }

  if (anyViolations) {
    console.error("\n❌ License audit failed: Disallowed or unapproved licenses found.");
    process.exit(1);
  }

  console.log("\n✅ Dependency license audit passed successfully.");
}

main();
