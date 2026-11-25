/**
 * Generates docs/API.md from the OpenAPI document the API serves.
 *
 * The spec is produced in-process from the route schemas (the same document
 * `GET /api/docs` returns), so the reference cannot drift from the code. The
 * hand-written preamble (versioning, auth, conventions) and footer (health,
 * rate limiting, caching, environment) are kept in scripts/api-reference/.
 *
 * Usage (run from backend/):
 *   npm run docs:api          regenerate docs/API.md
 *   npm run docs:api:check    exit 1 if docs/API.md is stale (used in CI)
 *
 * Runs with no database or Redis: the spec needs only route registration.
 */

import fs from "node:fs";
import path from "node:path";

import { DOCS_ROUTE } from "../src/api/openapi.js";
import { buildServer } from "../src/server.js";
import { createFakePool } from "../src/test/fakePool.js";
import { renderEndpoints } from "./api-reference/render.js";

/** Run from backend/, so these paths are relative to the package root. */
const PREAMBLE_PATH = path.resolve("scripts/api-reference/preamble.md");
const FOOTER_PATH = path.resolve("scripts/api-reference/footer.md");
const OUTPUT_PATH = path.resolve("../docs/API.md");

async function fetchSpec(): Promise<Record<string, unknown>> {
  const server = buildServer({ corsOrigins: [], logger: false, pool: createFakePool() });
  try {
    const res = await server.inject({ method: "GET", url: DOCS_ROUTE });
    if (res.statusCode !== 200) {
      throw new Error(`GET ${DOCS_ROUTE} returned ${res.statusCode}; cannot generate the reference`);
    }
    return res.json() as Record<string, unknown>;
  } finally {
    await server.close();
  }
}

export async function buildApiReference(): Promise<string> {
  const preamble = fs.readFileSync(PREAMBLE_PATH, "utf8").trimEnd();
  const footer = fs.readFileSync(FOOTER_PATH, "utf8").trim();
  const endpoints = renderEndpoints(await fetchSpec()).trimEnd();
  return `${preamble}\n\n${endpoints}\n\n${footer}\n`;
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const next = await buildApiReference();

  if (check) {
    const current = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, "utf8") : "";
    if (current !== next) {
      console.error("docs/API.md is out of date with the OpenAPI spec. Run `npm run docs:api` in backend/ and commit the result.");
      process.exitCode = 1;
      return;
    }
    console.log("docs/API.md is up to date.");
    return;
  }

  fs.writeFileSync(OUTPUT_PATH, next, "utf8");
  console.log(`Wrote ${path.relative(process.cwd(), OUTPUT_PATH)}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
