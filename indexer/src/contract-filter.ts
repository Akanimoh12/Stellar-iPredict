// Stellar Strkey for contracts: 'C' followed by 55 base-32 (A-Z2-7) characters
const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;

export function parseContractIds(csv: string): string[] {
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function validateContractId(id: string): boolean {
  return CONTRACT_ID_RE.test(id);
}

export interface ContractFilterConfig {
  /**
   * Comma-separated Stellar contract IDs.
   * Defaults to the CONTRACT_IDS environment variable when omitted.
   */
  raw?: string;
}

export function loadContractAllowlist(config: ContractFilterConfig = {}): string[] {
  const raw = config.raw ?? process.env.CONTRACT_IDS ?? "";
  if (!raw.trim()) {
    throw new Error(
      "CONTRACT_IDS must be set to a comma-separated list of Stellar contract IDs"
    );
  }

  const ids = parseContractIds(raw);
  const invalid = ids.filter((id) => !validateContractId(id));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid Stellar contract IDs (expected C + 55 base-32 chars): ${invalid.join(", ")}`
    );
  }

  return ids;
}

export function makeContractFilter(allowlist: string[]): (contractId: string) => boolean {
  const set = new Set(allowlist);
  return (contractId: string) => set.has(contractId);
}
