// ── Network Configuration ─────────────────────────────────────────────────────

export const NETWORK = {
  name: "testnet",
  url: process.env.NEXT_PUBLIC_HORIZON_URL || "https://horizon-testnet.stellar.org",
  passphrase:
    process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ||
    "Test SDF Network ; September 2015",
  sorobanUrl:
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
    "https://soroban-testnet.stellar.org",
  friendbotUrl:
    process.env.NEXT_PUBLIC_FRIENDBOT_URL ||
    "https://friendbot.stellar.org",
} as const;

// ── Contract IDs ──────────────────────────────────────────────────────────────
// Set via environment variables after deployment. Empty string = not deployed.

export const MARKET_CONTRACT_ID =
  process.env.NEXT_PUBLIC_MARKET_CONTRACT_ID || "";

export const TOKEN_CONTRACT_ID =
  process.env.NEXT_PUBLIC_TOKEN_CONTRACT_ID || "";

export const REFERRAL_CONTRACT_ID =
  process.env.NEXT_PUBLIC_REFERRAL_CONTRACT_ID || "";

export const LEADERBOARD_CONTRACT_ID =
  process.env.NEXT_PUBLIC_LEADERBOARD_CONTRACT_ID || "";

export const XLM_SAC_ID = process.env.NEXT_PUBLIC_XLM_SAC_ID || "";

// ── Admin ─────────────────────────────────────────────────────────────────────

export const ADMIN_PUBLIC_KEY =
  process.env.NEXT_PUBLIC_ADMIN_PUBLIC_KEY ||
  "GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD";

// ── Fee Model (basis points — BPS) ───────────────────────────────────────────
// 2% total fee deducted at bet time, split: 1.5% platform + 0.5% referrer

/** Total fee: 200 BPS = 2% */
export const TOTAL_FEE_BPS = 200;

/** Platform fee: 150 BPS = 1.5% — kept in AccumulatedFees */
export const PLATFORM_FEE_BPS = 150;

/** Referral fee: 50 BPS = 0.5% — sent to referrer if user has one */
export const REFERRAL_FEE_BPS = 50;

// ── Reward Constants ──────────────────────────────────────────────────────────

/** Bonus points a referrer earns per referred bet */
export const REFERRAL_BET_POINTS = 3;

/** Points awarded to a winning bettor */
export const WIN_POINTS = 30;

/** Points awarded to a losing bettor */
export const LOSE_POINTS = 10;

/** IPREDICT tokens awarded to a winning bettor (human-readable, 7 decimal) */
export const WIN_TOKENS = 10;

/** IPREDICT tokens awarded to a losing bettor (human-readable, 7 decimal) */
export const LOSE_TOKENS = 2;

/** Bonus points for registering via referral */
export const REGISTER_BONUS_POINTS = 5;

/** Bonus IPREDICT tokens for registering */
export const REGISTER_BONUS_TOKENS = 1;
