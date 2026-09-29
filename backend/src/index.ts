import { createApiServer } from "./server";
import { pool } from "./db/pool";

async function main(): Promise<void> {
  const app = await createApiServer(pool);
  app.addHook("onClose", async () => { await pool.end(); });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { void app.close(); });
  }
  await app.listen({ port: Number(process.env.PORT ?? 4000), host: process.env.HOST ?? "127.0.0.1" });
}
main().catch(err => { console.error(err); process.exitCode = 1; });
