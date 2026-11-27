import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { NETWORK } from "@/config/network";
import { AppErrorType } from "@/types";
import {
  isWalletType,
  WALLET_TYPE_STORAGE_KEY,
  type WalletType,
} from "./types";

// ── Wallet ID mapping ─────────────────────────────────────────────────────────

// ── Singleton instance ────────────────────────────────────────────────────────

let _kit: StellarWalletsKit | null = null;
let _kitPromise: Promise<StellarWalletsKit> | null = null;

function getSavedWalletId(
  walletKit: typeof import("@creit.tech/stellar-wallets-kit")
): string {
  if (typeof window === "undefined") return walletKit.FREIGHTER_ID;

  try {
    const savedType = window.localStorage.getItem(WALLET_TYPE_STORAGE_KEY);
    if (isWalletType(savedType)) {
      if (savedType === "xbull") return walletKit.XBULL_ID;
      if (savedType === "albedo") return walletKit.ALBEDO_ID;
      return walletKit.FREIGHTER_ID;
    }
  } catch (err) {
    console.warn("[iPredict][wallet] unable to restore saved wallet selection", err);
  }

  return walletKit.FREIGHTER_ID;
}

/**
 * Get or create the StellarWalletsKit singleton.
 * Lazy-initialized on first call with Freighter, xBull, and Albedo modules.
 */
export async function getWalletKit(): Promise<StellarWalletsKit> {
  if (_kit) return _kit;
  if (!_kitPromise) {
    _kitPromise = import("@creit.tech/stellar-wallets-kit").then((walletKit) => {
      const networkPassphrase =
        NETWORK.passphrase === "Test SDF Network ; September 2015"
          ? walletKit.WalletNetwork.TESTNET
          : walletKit.WalletNetwork.PUBLIC;

      const kit = new walletKit.StellarWalletsKit({
        network: networkPassphrase,
        selectedWalletId: getSavedWalletId(walletKit),
        modules: [
          new walletKit.FreighterModule(),
          new walletKit.xBullModule(),
          new walletKit.AlbedoModule(),
        ],
      });
      _kit = kit;
      return kit;
    });
  }
  return _kitPromise;
}

/**
 * Select a wallet type in the kit.
 */
export async function selectWallet(type: WalletType): Promise<void> {
  const [kit, walletKit] = await Promise.all([
    getWalletKit(),
    import("@creit.tech/stellar-wallets-kit"),
  ]);
  const walletId =
    type === "freighter"
      ? walletKit.FREIGHTER_ID
      : type === "xbull"
        ? walletKit.XBULL_ID
        : walletKit.ALBEDO_ID;
  kit.setWallet(walletId);
}

/**
 * Connect to the selected wallet and return the public key.
 */
export async function connectKit(): Promise<{ publicKey: string }> {
  try {
    const kit = await getWalletKit();
    const { address } = await kit.getAddress();
    return { publicKey: address };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to connect wallet";

    // Detect extension not installed
    if (
      message.toLowerCase().includes("not installed") ||
      message.toLowerCase().includes("not available") ||
      message.toLowerCase().includes("no provider")
    ) {
      throw {
        type: AppErrorType.WALLET,
        message: "Wallet extension not installed",
        details: message,
      };
    }

    // Detect user rejection
    if (
      message.toLowerCase().includes("rejected") ||
      message.toLowerCase().includes("denied") ||
      message.toLowerCase().includes("cancelled")
    ) {
      throw {
        type: AppErrorType.WALLET,
        message: "Connection request rejected by user",
        details: message,
      };
    }

    throw {
      type: AppErrorType.WALLET,
      message: "Failed to connect wallet",
      details: message,
    };
  }
}

/**
 * Sign a transaction XDR string with the currently selected wallet.
 * Returns the signed XDR string.
 */
export async function signWithKit(xdr: string): Promise<string> {
  try {
    const kit = await getWalletKit();
    const { signedTxXdr } = await kit.signTransaction(xdr, {
      networkPassphrase: NETWORK.passphrase,
    });
    return signedTxXdr;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to sign transaction";

    if (
      message.toLowerCase().includes("network") &&
      (message.toLowerCase().includes("mismatch") ||
        message.toLowerCase().includes("passphrase") ||
        message.toLowerCase().includes("wrong"))
    ) {
      throw {
        type: AppErrorType.WALLET,
        message: "Wallet network does not match the iPredict network",
        details: message,
      };
    }

    if (
      message.toLowerCase().includes("rejected") ||
      message.toLowerCase().includes("denied") ||
      message.toLowerCase().includes("cancelled")
    ) {
      throw {
        type: AppErrorType.WALLET,
        message: "Transaction signing rejected by user",
        details: message,
      };
    }

    throw {
      type: AppErrorType.WALLET,
      message: "Failed to sign transaction",
      details: message,
    };
  }
}

/**
 * Get current network details from kit or fallback to configured network.
 */
export async function getNetworkDetails(): Promise<{
  network?: string;
  networkPassphrase?: string;
}> {
  try {
    const kit = await getWalletKit();
    const untypedKit = kit as unknown as Record<string, unknown>;
    if (typeof untypedKit.getNetwork === "function") {
      const res = await (untypedKit.getNetwork as () => Promise<unknown>)();
      if (typeof res === "string") return { network: res };
      if (typeof res === "object" && res !== null) return res as { network?: string; networkPassphrase?: string };
    }
    if (typeof untypedKit.getNetworkDetails === "function") {
      const res = await (untypedKit.getNetworkDetails as () => Promise<unknown>)();
      if (typeof res === "object" && res !== null) return res as { network?: string; networkPassphrase?: string };
    }
    return { networkPassphrase: NETWORK.passphrase };
  } catch {
    return { networkPassphrase: NETWORK.passphrase };
  }
}
