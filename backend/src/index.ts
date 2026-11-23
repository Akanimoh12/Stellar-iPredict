/**
 * iPredict Backend API — entrypoint.
 *
 * Run: `npm run dev`
 *
 * This is the only place the backend exits on a startup failure. The steps
 * themselves live in `startup.ts` and throw.
 */

import { reportStartupFailure } from "@ipredict/shared";
import { startBackend } from "./startup.js";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "0.0.0.0";

startBackend({ port: PORT, host: HOST }).catch((error: unknown) => {
  reportStartupFailure("ipredict-backend", error);
  process.exit(1);
});
