export interface EventLogRow {
  id: number;
  ledgerSeq: number;
  eventType: string;
  marketId: number | null;
  actor: string | null;
  payload: unknown;
}

export interface LeaderboardRow {
  address: string;
  displayName: string;
  points: number;
  wonBets: number;
  lostBets: number;
}

export interface LeaderboardSnapshot {
  players: LeaderboardRow[];
  eventCount: number;
  lastLedgerSeq: number | null;
}

export interface Queryable {
  query(
    text: string,
    params?: readonly unknown[]
  ): Promise<{ rows: any[] }>;
}

export interface RebuildOptions {
  dryRun?: boolean;
  sinceLedger?: number;
}

interface PlayerState extends LeaderboardRow {
  lastTouchedLedger: number;
}

interface EventRowRecord {
  id: number | string;
  ledger_seq: number | string;
  event_type: string;
  market_id: number | string | null;
  actor: string | null;
  payload: unknown;
}

const CLAIM_EVENT_TYPES = new Set([
  "reward_claimed",
  "market_reward_claimed",
  "claim_rewarded",
]);

const REFERRAL_REGISTRATION_TYPES = new Set([
  "referral_registered",
  "registered_referral",
]);

const REFERRAL_BONUS_TYPES = new Set([
  "referral_credited",
  "referral_bonus",
  "bonus_points_awarded",
  "leaderboard_bonus",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return null;
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toBooleanOrNull(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "t", "yes", "y", "win", "winner", "won", "1"].includes(normalized)) {
      return true;
    }
    if (["false", "f", "no", "n", "lose", "loser", "lost", "0"].includes(normalized)) {
      return false;
    }
  }
  return null;
}

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = toStringOrNull(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = toNumberOrNull(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function firstBoolean(source: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = toBooleanOrNull(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function looksLikeClaimEvent(eventType: string, payload: Record<string, unknown>): boolean {
  if (CLAIM_EVENT_TYPES.has(eventType)) return true;
  return (
    eventType.includes("claim") ||
    (firstBoolean(payload, ["is_winner", "isWinner", "won"]) !== null &&
      firstNumber(payload, ["points", "points_delta", "reward_points"]) !== null)
  );
}

function getPlayer(
  players: Map<string, PlayerState>,
  address: string,
  ledgerSeq: number
): PlayerState {
  const existing = players.get(address);
  if (existing) {
    existing.lastTouchedLedger = Math.max(existing.lastTouchedLedger, ledgerSeq);
    return existing;
  }

  const created: PlayerState = {
    address,
    displayName: "",
    points: 0,
    wonBets: 0,
    lostBets: 0,
    lastTouchedLedger: ledgerSeq,
  };
  players.set(address, created);
  return created;
}

function applyPointsDelta(player: PlayerState, delta: number): void {
  player.points += delta;
}

function handleClaimEvent(
  players: Map<string, PlayerState>,
  event: EventLogRow,
  payload: Record<string, unknown>
): void {
  const user =
    firstString(payload, ["user", "address", "bettor", "recipient"]) ?? event.actor;
  if (!user) return;

  const player = getPlayer(players, user, event.ledgerSeq);
  const displayName = firstString(payload, ["display_name", "displayName", "name"]);
  if (displayName) player.displayName = displayName;

  const isWinner = firstBoolean(payload, ["is_winner", "isWinner", "won"]) ?? false;
  const points =
    firstNumber(payload, ["points", "points_delta", "reward_points"]) ??
    (isWinner ? 30 : 10);

  applyPointsDelta(player, points);
  if (isWinner) {
    player.wonBets += 1;
  } else {
    player.lostBets += 1;
  }
}

function handleReferralRegistration(
  players: Map<string, PlayerState>,
  event: EventLogRow,
  payload: Record<string, unknown>
): void {
  const user =
    firstString(payload, ["user", "address", "registrant"]) ?? event.actor;
  if (!user) return;

  const userPlayer = getPlayer(players, user, event.ledgerSeq);
  const displayName = firstString(payload, ["display_name", "displayName", "name"]);
  if (displayName) userPlayer.displayName = displayName;

  const welcomeBonus = firstNumber(payload, ["welcome_bonus_points", "points"]) ?? 5;
  applyPointsDelta(userPlayer, welcomeBonus);

  const referrer = firstString(payload, ["referrer", "referrer_address"]);
  if (!referrer) return;

  const referrerBonus = firstNumber(
    payload,
    ["referrer_bonus_points", "bonus_points", "referral_points"]
  ) ?? 5;
  applyPointsDelta(getPlayer(players, referrer, event.ledgerSeq), referrerBonus);
}

function handleReferralBonus(
  players: Map<string, PlayerState>,
  event: EventLogRow,
  payload: Record<string, unknown>
): void {
  const target =
    firstString(payload, ["referrer", "user", "address", "recipient"]) ?? event.actor;
  if (!target) return;

  const player = getPlayer(players, target, event.ledgerSeq);
  const displayName = firstString(payload, ["display_name", "displayName", "name"]);
  if (displayName) player.displayName = displayName;

  const delta = firstNumber(payload, ["points", "bonus_points", "points_delta"]) ?? 3;
  applyPointsDelta(player, delta);
}

export function buildLeaderboardSnapshot(events: EventLogRow[]): LeaderboardSnapshot {
  const players = new Map<string, PlayerState>();
  let eventCount = 0;
  let lastLedgerSeq: number | null = null;

  for (const event of events) {
    eventCount += 1;
    lastLedgerSeq = event.ledgerSeq;
    const payload = asRecord(event.payload);

    if (looksLikeClaimEvent(event.eventType, payload)) {
      handleClaimEvent(players, event, payload);
      continue;
    }

    if (REFERRAL_REGISTRATION_TYPES.has(event.eventType) || event.eventType.includes("register")) {
      handleReferralRegistration(players, event, payload);
      continue;
    }

    if (REFERRAL_BONUS_TYPES.has(event.eventType) || event.eventType.includes("referral")) {
      handleReferralBonus(players, event, payload);
      continue;
    }

    const target =
      firstString(payload, ["user", "address", "actor", "recipient"]) ?? event.actor;
    const delta = firstNumber(payload, ["points", "points_delta", "bonus_points"]);
    if (!target || delta === null) continue;

    const player = getPlayer(players, target, event.ledgerSeq);
    const displayName = firstString(payload, ["display_name", "displayName", "name"]);
    if (displayName) player.displayName = displayName;
    applyPointsDelta(player, delta);
  }

  const snapshotPlayers = [...players.values()]
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.wonBets !== a.wonBets) return b.wonBets - a.wonBets;
      if (a.lostBets !== b.lostBets) return a.lostBets - b.lostBets;
      return a.address.localeCompare(b.address);
    })
    .map(({ lastTouchedLedger: _lastTouchedLedger, ...row }) => row);

  return {
    players: snapshotPlayers,
    eventCount,
    lastLedgerSeq,
  };
}

export async function rebuildLeaderboardTable(
  db: Queryable,
  options: RebuildOptions = {}
): Promise<LeaderboardSnapshot> {
  const queryParts = [
    "SELECT id, ledger_seq, event_type, market_id, actor, payload",
    "FROM events",
  ];
  const queryParams: unknown[] = [];

  if (options.sinceLedger !== undefined) {
    queryParams.push(options.sinceLedger);
    queryParts.push(`WHERE ledger_seq >= $${queryParams.length}`);
  }

  queryParts.push("ORDER BY ledger_seq ASC, id ASC");

  const { rows } = await db.query(queryParts.join(" "), queryParams);

  const events = rows.map((row) => ({
    id: Number(row.id),
    ledgerSeq: Number(row.ledger_seq),
    eventType: String(row.event_type),
    marketId: row.market_id === null ? null : Number(row.market_id),
    actor: row.actor,
    payload: row.payload,
  }));

  const snapshot = buildLeaderboardSnapshot(events);
  if (options.dryRun) {
    return snapshot;
  }

  await db.query("DELETE FROM leaderboard");

  if (snapshot.players.length === 0) {
    return snapshot;
  }

  const values: unknown[] = [];
  const placeholders = snapshot.players.map((player, index) => {
    const offset = index * 5;
    values.push(
      player.address,
      player.displayName || null,
      player.points,
      player.wonBets,
      player.lostBets
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, NOW())`;
  });

  await db.query(
    [
      "INSERT INTO leaderboard (address, display_name, points, won_bets, lost_bets, updated_at)",
      `VALUES ${placeholders.join(", ")}`,
      "ON CONFLICT (address) DO UPDATE SET",
      "  display_name = EXCLUDED.display_name,",
      "  points = EXCLUDED.points,",
      "  won_bets = EXCLUDED.won_bets,",
      "  lost_bets = EXCLUDED.lost_bets,",
      "  updated_at = NOW()",
    ].join(" "),
    values
  );

  return snapshot;
}
