export type WalletType = "freighter" | "albedo" | "xbull";

export const WALLET_TYPE_STORAGE_KEY = "ip_wallet_type";
export const WALLET_PUBKEY_STORAGE_KEY = "ip_wallet_pubkey";

export function isWalletType(value: unknown): value is WalletType {
  return value === "freighter" || value === "albedo" || value === "xbull";
}

export interface Wallet {
  publicKey: string;
  walletType: WalletType;
}
