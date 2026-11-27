"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
} from "react";
import {
  isWalletType,
  WALLET_PUBKEY_STORAGE_KEY,
  WALLET_TYPE_STORAGE_KEY,
  type WalletType,
} from "@/wallet/types";
import { AppErrorType } from "@/types";
import type { AppError } from "@/types";
import { setSimulationSource } from "@/services/soroban";
import { NETWORK } from "@/config/network";

// ── localStorage keys ─────────────────────────────────────────────────────────

export const WALLET_TYPE_KEY = WALLET_TYPE_STORAGE_KEY;
export const WALLET_PUBKEY_KEY = WALLET_PUBKEY_STORAGE_KEY;

// ── Context shape ─────────────────────────────────────────────────────────────

export interface WalletContextValue {
  publicKey: string | null;
  walletType: WalletType | null;
  connected: boolean;
  connecting: boolean;
  network?: string | null;
  networkPassphrase?: string | null;
  error: AppError | null;
  connect: (type: WalletType) => Promise<void>;
  disconnect: () => void;
  signTransaction: (xdr: string) => Promise<string>;
}

export interface LazyWalletKit {
  selectWallet: (type: WalletType) => Promise<void>;
  connectKit: () => Promise<{ publicKey: string }>;
  signWithKit: (xdr: string) => Promise<string>;
  getNetworkDetails?: () => Promise<{
    network?: string;
    networkPassphrase?: string;
  }>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

// ── Wallet State Hook ─────────────────────────────────────────────────────────

export function useWalletState(enabled = true): WalletContextValue {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [walletType, setWalletType] = useState<WalletType | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [network, setNetwork] = useState<string | null>(null);
  const [networkPassphrase, setNetworkPassphrase] = useState<string | null>(null);

  const kitRef = useRef<LazyWalletKit | null>(null);

  // Lazy-load the wallet kit module (client-only)
  const getKit = useCallback(async (): Promise<LazyWalletKit> => {
    if (!kitRef.current) {
      const kitModule: unknown = await import("@/wallet/kit");
      if (
        typeof kitModule === "object" &&
        kitModule !== null &&
        "default" in kitModule
      ) {
        const defaultExport = (kitModule as { default: unknown }).default;
        if (typeof defaultExport === "object" && defaultExport !== null) {
          kitRef.current = defaultExport as LazyWalletKit;
        }
      }
      if (!kitRef.current) {
        kitRef.current = kitModule as LazyWalletKit;
      }
    }
    return kitRef.current;
  }, []);

  // ── Disconnect ──────────────────────────────────────────────────────────────

  const disconnect = useCallback(() => {
    setPublicKey(null);
    setWalletType(null);
    setError(null);
    setNetwork(null);
    setNetworkPassphrase(null);
    setSimulationSource(null);
    clearSavedWallet();
  }, []);

  // ── Auto-reconnect on mount ───────────────────────────────────────────────

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    const savedType = readSavedWalletType();

    if (savedType) {
      (async () => {
        try {
          const kit = await getKit();
          await kit.selectWallet(savedType);
          const { publicKey: pk } = await kit.connectKit();
          setPublicKey(pk);
          setWalletType(savedType);
          setSimulationSource(pk);

          if (kit.getNetworkDetails) {
            try {
              const net = await kit.getNetworkDetails();
              setNetwork(net.network || null);
              setNetworkPassphrase(net.networkPassphrase || null);
            } catch {
              // Ignore network query failures during auto-reconnect
            }
          }
        } catch {
          // Silent fail — clear stale stored state
          clearSavedWallet();
        }
      })();
    }
  }, [enabled, getKit]);

  // ── Connect ─────────────────────────────────────────────────────────────────

  const connect = useCallback(
    async (type: WalletType) => {
      setConnecting(true);
      setError(null);

      try {
        const kit = await getKit();
        await kit.selectWallet(type);
        const { publicKey: pk } = await kit.connectKit();

        setPublicKey(pk);
        setWalletType(type);
        setSimulationSource(pk);

        persistSavedWallet(type, pk);

        if (kit.getNetworkDetails) {
          try {
            const net = await kit.getNetworkDetails();
            setNetwork(net.network || null);
            setNetworkPassphrase(net.networkPassphrase || null);
          } catch {
            // Ignore network query failures
          }
        }
      } catch (err) {
        const appError = isAppError(err)
          ? err
          : {
              type: AppErrorType.WALLET,
              message:
                err instanceof Error
                  ? err.message
                  : "Failed to connect wallet",
            };
        setError(appError);
        throw appError;
      } finally {
        setConnecting(false);
      }
    },
    [getKit]
  );

  // ── Sign Transaction ────────────────────────────────────────────────────────

  const signTransaction = useCallback(
    async (xdr: string): Promise<string> => {
      const kit = await getKit();
      return kit.signWithKit(xdr);
    },
    [getKit]
  );

  // ── Account & Network Change Detection ──────────────────────────────────────

  const checkAccountAndNetwork = useCallback(async () => {
    if (!publicKey) return;

    try {
      const kit = await getKit();
      const { publicKey: currentPk } = await kit.connectKit();

      if (!currentPk) {
        // Account became unavailable/revoked in wallet
        disconnect();
        return;
      }

      if (currentPk !== publicKey) {
        // Account switched in extension
        setPublicKey(currentPk);
        setSimulationSource(currentPk);
        persistSavedPublicKey(currentPk);
      }

      if (kit.getNetworkDetails) {
        try {
          const net = await kit.getNetworkDetails();
          const netName = net.network || null;
          const netPassphrase = net.networkPassphrase || null;
          setNetwork(netName);
          setNetworkPassphrase(netPassphrase);

          if (netPassphrase && netPassphrase !== NETWORK.passphrase) {
            setError({
              type: AppErrorType.WALLET,
              message: `Wallet network mismatch: extension is on ${netName || netPassphrase}, expected ${NETWORK.name}`,
            });
          }
        } catch {
          // Ignore network detail failures
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.toLowerCase().includes("locked") ||
        message.toLowerCase().includes("revoked") ||
        message.toLowerCase().includes("denied") ||
        message.toLowerCase().includes("disconnected") ||
        message.toLowerCase().includes("not authorized")
      ) {
        disconnect();
      }
    }
  }, [publicKey, disconnect, getKit]);

  // Listen to window events, focus, visibility, and periodic polling while connected
  useEffect(() => {
    if (!enabled || !publicKey || typeof window === "undefined") return;

    const handleAccountChange = (e: Event) => {
      const customEvent = e as CustomEvent<{
        publicKey?: string;
        address?: string;
      }>;
      const newPk =
        customEvent.detail?.publicKey || customEvent.detail?.address;

      if (newPk) {
        if (newPk !== publicKey) {
          setPublicKey(newPk);
          setSimulationSource(newPk);
          persistSavedPublicKey(newPk);
        }
      } else if (
        customEvent.detail &&
        ("publicKey" in customEvent.detail || "address" in customEvent.detail)
      ) {
        disconnect();
      } else {
        void checkAccountAndNetwork();
      }
    };

    const handleNetworkChange = (e: Event) => {
      const customEvent = e as CustomEvent<{
        network?: string;
        networkPassphrase?: string;
      }>;
      if (customEvent.detail) {
        const netName = customEvent.detail.network || null;
        const netPassphrase = customEvent.detail.networkPassphrase || null;
        if (netName) setNetwork(netName);
        if (netPassphrase) {
          setNetworkPassphrase(netPassphrase);
          if (netPassphrase !== NETWORK.passphrase) {
            setError({
              type: AppErrorType.WALLET,
              message: `Wallet network mismatch: extension is on ${netName || netPassphrase}, expected ${NETWORK.name}`,
            });
          }
        }
      } else {
        void checkAccountAndNetwork();
      }
    };

    const onFocus = () => {
      void checkAccountAndNetwork();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void checkAccountAndNetwork();
      }
    };

    window.addEventListener("stellar:accountChanged", handleAccountChange);
    window.addEventListener("freighter:accountChanged", handleAccountChange);
    window.addEventListener("wallet:accountChanged", handleAccountChange);
    window.addEventListener("stellar:networkChanged", handleNetworkChange);
    window.addEventListener("freighter:networkChanged", handleNetworkChange);
    window.addEventListener("wallet:networkChanged", handleNetworkChange);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    const intervalId = setInterval(() => {
      if (document.visibilityState !== "hidden") {
        void checkAccountAndNetwork();
      }
    }, 2000);

    return () => {
      window.removeEventListener("stellar:accountChanged", handleAccountChange);
      window.removeEventListener("freighter:accountChanged", handleAccountChange);
      window.removeEventListener("wallet:accountChanged", handleAccountChange);
      window.removeEventListener("stellar:networkChanged", handleNetworkChange);
      window.removeEventListener("freighter:networkChanged", handleNetworkChange);
      window.removeEventListener("wallet:networkChanged", handleNetworkChange);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearInterval(intervalId);
    };
  }, [enabled, publicKey, checkAccountAndNetwork, disconnect]);

  return {
    publicKey,
    walletType,
    connected: publicKey !== null,
    connecting,
    network,
    networkPassphrase,
    error,
    connect,
    disconnect,
    signTransaction,
  };
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const wallet = useWalletState(true);

  return (
    <WalletContext.Provider value={wallet}>
      {children}
    </WalletContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useWallet() {
  const context = useContext(WalletContext);
  const fallback = useWalletState(context === null);
  return context ?? fallback;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isAppError(err: unknown): err is AppError {
  return (
    typeof err === "object" &&
    err !== null &&
    "type" in err &&
    "message" in err
  );
}

function readSavedWalletType(): WalletType | null {
  try {
    const type = window.localStorage.getItem(WALLET_TYPE_KEY);
    const publicKey = window.localStorage.getItem(WALLET_PUBKEY_KEY);
    if (isWalletType(type) && publicKey) return type;
    if (type !== null || publicKey !== null) clearSavedWallet();
  } catch (err) {
    console.warn("[iPredict][wallet] unable to read saved wallet", err);
  }
  return null;
}

function persistSavedWallet(type: WalletType, publicKey: string): void {
  try {
    window.localStorage.setItem(WALLET_TYPE_KEY, type);
    window.localStorage.setItem(WALLET_PUBKEY_KEY, publicKey);
  } catch (err) {
    console.warn("[iPredict][wallet] unable to remember wallet selection", err);
  }
}

function persistSavedPublicKey(publicKey: string): void {
  try {
    window.localStorage.setItem(WALLET_PUBKEY_KEY, publicKey);
  } catch (err) {
    console.warn("[iPredict][wallet] unable to remember wallet account", err);
  }
}

function clearSavedWallet(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(WALLET_TYPE_KEY);
    window.localStorage.removeItem(WALLET_PUBKEY_KEY);
  } catch (err) {
    console.warn("[iPredict][wallet] unable to clear remembered wallet", err);
  }
}
