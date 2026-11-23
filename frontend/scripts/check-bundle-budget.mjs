import { readFileSync, statSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const nextDir = resolve(".next");
const budgetBytes = 350 * 1024;
const routeLimits = [
  { manifestKey: "/page", label: "/" },
  { manifestKey: "/markets/page", label: "/markets" },
  { manifestKey: "/markets/[id]/page", label: "/markets/[id]" },
  { manifestKey: "/leaderboard/page", label: "/leaderboard" },
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const manifestPath = resolve(nextDir, "app-build-manifest.json");
if (!existsSync(manifestPath)) {
  console.error("Bundle budget check requires a production Next.js build.");
  process.exit(1);
}

const appManifest = readJson(manifestPath);
const buildManifest = readJson(resolve(nextDir, "build-manifest.json"));
const pages = appManifest.pages ?? {};
const rootMainFiles = buildManifest.rootMainFiles ?? [];
const failures = [];

for (const route of routeLimits) {
  const routeFiles = pages[route.manifestKey] ?? [];
  if (routeFiles.length === 0) continue;

  const files = new Set([...rootMainFiles, ...routeFiles]);
  let size = 0;
  for (const file of files) {
    const outputPath = resolve(nextDir, file.replace(/^\.?\/*/, ""));
    if (existsSync(outputPath)) size += statSync(outputPath).size;
  }

  const sizeKb = (size / 1024).toFixed(1);
  console.log(`${route.label}: ${sizeKb} KB`);
  if (size > budgetBytes) {
    failures.push(`${route.label} exceeds ${budgetBytes / 1024} KB (${sizeKb} KB)`);
  }
}

if (failures.length > 0) {
  console.error(`\nBundle budget failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
