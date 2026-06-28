/**
 * iPredict Oracle — entrypoint.
 *
 * Minimal scaffold. The council aggregator, data adapters, submitter, and
 * monitor are tracked as separate issues (see GitHub issues labelled
 * `area:oracle`).
 *
 * Run: `npm run dev`
 */

async function main(): Promise<void> {
  // TODO(#scaffold): wire up the aggregator / monitor once their issues land.
  console.log(`[ipredict-oracle] scaffold up — oracle services not yet implemented`);
  console.log(`[ipredict-oracle] pick an issue labelled "area:oracle" to start`);
}

main().catch((err) => {
  console.error("[ipredict-oracle] fatal:", err);
  process.exit(1);
});
