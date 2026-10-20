/**
 * Backward-compatible import surface.
 *
 * Token mint and transfer behavior is implemented together in `token.ts` so
 * the registry, direct imports, and generic token router cannot drift into
 * separate accounting paths. Keep this module as a re-export because older
 * consumers import `handlers/token_mint` directly.
 */
export {
  decodeTokenMint,
  handleTokenMint,
  TOKEN_MINT_TOPIC,
  type TokenMintPayload,
} from "./token.js";
