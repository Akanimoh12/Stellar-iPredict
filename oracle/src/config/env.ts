import { z } from "zod";

/**
 * Treats an empty environment variable as absent.
 *
 * `.env` files spell "not configured" as `FINALIZE_WEBHOOK_URL=` — the key is
 * present with an empty value. Zod sees a defined empty string, so a bare
 * `.url().optional()` rejects it and the service exits at startup. Every
 * optional variable in a checked-in `.env.example` would otherwise have to be
 * commented out to be usable, which is not how operators edit these files.
 *
 * Wrap the *inner* schema, not the `.optional()`:
 *
 *   RESOLVER_KEY: optionalEnv(z.string().min(1)),
 */
export function optionalEnv<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema.optional(),
  );
}
