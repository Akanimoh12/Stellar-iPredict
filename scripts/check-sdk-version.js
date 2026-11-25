import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const oraclePkgPath = path.join(rootDir, "oracle", "package.json");
const backendPkgPath = path.join(rootDir, "backend", "package.json");

const oraclePkg = JSON.parse(fs.readFileSync(oraclePkgPath, "utf8"));
const backendPkg = JSON.parse(fs.readFileSync(backendPkgPath, "utf8"));

const oracleVer = oraclePkg.dependencies?.["@stellar/stellar-sdk"];
const backendVer = backendPkg.dependencies?.["@stellar/stellar-sdk"];

if (!oracleVer || !backendVer) {
  console.error("Could not find @stellar/stellar-sdk in package.json dependencies.");
  process.exit(1);
}

if (oracleVer !== backendVer) {
  console.error(
    `Dependency divergence detected for @stellar/stellar-sdk: oracle=${oracleVer}, backend=${backendVer}`
  );
  process.exit(1);
}

console.log(
  `@stellar/stellar-sdk versions aligned: oracle=${oracleVer}, backend=${backendVer}`
);
