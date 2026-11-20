import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useWallet } from "@/hooks/useWallet";

// Mock wallet kit
const mockWalletKit = {
  selectWallet: vi.fn(),
  connectKit: vi.fn(),
  signTransaction: vi.fn(),
};

vi.mock("@/wallet/kit", async () => ({
  default: mockWalletKit,
}));

vi.mock("@/services/soroban", () => ({
  setSimulationSource: vi.fn(),
}));

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
});

describe("useWallet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("should initialize with disconnected state", () => {
    const { result } = renderHook(() => useWallet());

    expect(result.current.publicKey).toBeNull();
    expect(result.current.walletType).toBeNull();
    expect(result.current.connected).toBe(false);
    expect(result.current.connecting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("should connect to wallet", async () => {
    mockWalletKit.connectKit.mockResolvedValue({
      publicKey: "GCONNECTED123...",
    });

    const { result } = renderHook(() => useWallet());

    await act(async () => {
      await result.current.connect("freighter");
    });

    await waitFor(() => {
      expect(result.current.publicKey).toBe("GCONNECTED123...");
      expect(result.current.walletType).toBe("freighter");
      expect(result.current.connected).toBe(true);
      expect(result.current.connecting).toBe(false);
    });
  });

  it("should handle connection error", async () => {
    const connectionError = new Error("User rejected connection");
    mockWalletKit.connectKit.mockRejectedValue(connectionError);

    const { result } = renderHook(() => useWallet());

    await act(async () => {
      try {
        await result.current.connect("freighter");
      } catch {
        // Error is caught
      }
    });

    await waitFor(() => {
      expect(result.current.connected).toBe(false);
      expect(result.current.error).not.toBeNull();
    });
  });

  it("should disconnect wallet", async () => {
    mockWalletKit.connectKit.mockResolvedValue({
      publicKey: "GCONNECTED123...",
    });

    const { result } = renderHook(() => useWallet());

    await act(async () => {
      await result.current.connect("freighter");
    });

    await waitFor(() => {
      expect(result.current.connected).toBe(true);
    });

    act(() => {
      result.current.disconnect();
    });

    expect(result.current.publicKey).toBeNull();
    expect(result.current.connected).toBe(false);
  });

  it("should sign transaction", async () => {
    mockWalletKit.connectKit.mockResolvedValue({
      publicKey: "GTEST123...",
    });
    mockWalletKit.signTransaction.mockResolvedValue("signed_xdr_123");

    const { result } = renderHook(() => useWallet());

    await act(async () => {
      await result.current.connect("freighter");
    });

    let signedXdr: string | null = null;
    await act(async () => {
      signedXdr = await result.current.signTransaction("unsigned_xdr");
    });

    expect(signedXdr).toBe("signed_xdr_123");
  });

  it("should persist wallet selection to localStorage", async () => {
    mockWalletKit.connectKit.mockResolvedValue({
      publicKey: "GTEST123...",
    });

    const { result } = renderHook(() => useWallet());

    await act(async () => {
      await result.current.connect("albedo");
    });

    await waitFor(() => {
      expect(localStorage.getItem("ip_wallet_type")).toBe("albedo");
      expect(localStorage.getItem("ip_wallet_pubkey")).toBe("GTEST123...");
    });
  });

  it("should auto-reconnect from localStorage on mount", async () => {
    localStorage.setItem("ip_wallet_type", "freighter");
    localStorage.setItem("ip_wallet_pubkey", "GPERSISTED123...");

    mockWalletKit.connectKit.mockResolvedValue({
      publicKey: "GPERSISTED123...",
    });

    const { result } = renderHook(() => useWallet());

    await waitFor(() => {
      expect(mockWalletKit.selectWallet).toHaveBeenCalledWith("freighter");
      expect(mockWalletKit.connectKit).toHaveBeenCalled();
    });
  });

  it("should clear localStorage on failed auto-reconnect", async () => {
    localStorage.setItem("ip_wallet_type", "freighter");
    localStorage.setItem("ip_wallet_pubkey", "GSTALE123...");

    mockWalletKit.connectKit.mockRejectedValue(new Error("Connection failed"));

    renderHook(() => useWallet());

    await waitFor(() => {
      expect(localStorage.getItem("ip_wallet_type")).toBeNull();
      expect(localStorage.getItem("ip_wallet_pubkey")).toBeNull();
    });
  });

  it("should handle multiple wallet types", async () => {
    mockWalletKit.connectKit.mockResolvedValue({
      publicKey: "GTEST123...",
    });

    const { result } = renderHook(() => useWallet());

    const walletTypes: Array<"freighter" | "albedo" | "xbull"> = [
      "freighter",
      "albedo",
      "xbull",
    ];

    for (const walletType of walletTypes) {
      await act(async () => {
        await result.current.connect(walletType);
      });

      await waitFor(() => {
        expect(result.current.walletType).toBe(walletType);
        expect(mockWalletKit.selectWallet).toHaveBeenCalledWith(walletType);
      });
    }
  });

  it("should track connecting state during connection", async () => {
    let resolveConnect: (value: { publicKey: string }) => void;
    const connectPromise = new Promise<{ publicKey: string }>(resolve => {
      resolveConnect = resolve;
    });

    mockWalletKit.connectKit.mockReturnValue(connectPromise);

    const { result } = renderHook(() => useWallet());

    expect(result.current.connecting).toBe(false);

    act(() => {
      result.current.connect("freighter");
    });

    await waitFor(() => {
      expect(result.current.connecting).toBe(true);
    });

    act(() => {
      resolveConnect({ publicKey: "GTEST123..." });
    });

    await waitFor(() => {
      expect(result.current.connecting).toBe(false);
    });
  });

  it("should update connected flag based on publicKey", async () => {
    mockWalletKit.connectKit.mockResolvedValue({
      publicKey: "GTEST123...",
    });

    const { result } = renderHook(() => useWallet());

    expect(result.current.connected).toBe(false);

    await act(async () => {
      await result.current.connect("freighter");
    });

    await waitFor(() => {
      expect(result.current.connected).toBe(true);
    });

    act(() => {
      result.current.disconnect();
    });

    expect(result.current.connected).toBe(false);
  });
});
