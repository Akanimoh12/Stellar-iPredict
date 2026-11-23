import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useClaim } from "@/hooks/useClaim";
import type { TransactionResult } from "@/types";

// Mock dependencies
vi.mock("@/hooks/useWallet", () => ({
  useWallet: vi.fn(() => ({
    publicKey: "GTEST123...",
    signTransaction: vi.fn().mockResolvedValue("signed_xdr"),
  })),
}));

vi.mock("@/services/market", () => ({
  claim: vi.fn(),
}));

import { claim } from "@/services/market";
import { useWallet } from "@/hooks/useWallet";

describe("useClaim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should initialize with idle state", () => {
    const { result } = renderHook(() => useClaim());

    expect(result.current.loading).toBe(false);
    expect(result.current.stage).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(result.current.result).toBeNull();
  });

  it("should handle successful claim", async () => {
    const mockResult: TransactionResult = {
      success: true,
      txHash: "tx_claim_123",
      timestamp: Date.now(),
    };

    vi.mocked(claim).mockResolvedValue(mockResult);

    const { result } = renderHook(() => useClaim());

    await act(async () => {
      await result.current.submit(1);
    });

    await waitFor(() => {
      expect(result.current.stage).toBe("confirmed");
      expect(result.current.result).toEqual(mockResult);
      expect(result.current.error).toBeNull();
      expect(result.current.loading).toBe(false);
    });
  });

  it("should handle failed claim", async () => {
    const mockResult: TransactionResult = {
      success: false,
      error: "No winnings to claim",
    };

    vi.mocked(claim).mockResolvedValue(mockResult);

    const { result } = renderHook(() => useClaim());

    await act(async () => {
      await result.current.submit(1);
    });

    await waitFor(() => {
      expect(result.current.stage).toBe("failed");
      expect(result.current.error).toBe("No winnings to claim");
      expect(result.current.loading).toBe(false);
    });
  });

  it("should handle exception during claim", async () => {
    const error = new Error("RPC timeout");
    vi.mocked(claim).mockRejectedValue(error);

    const { result } = renderHook(() => useClaim());

    await act(async () => {
      await result.current.submit(1);
    });

    await waitFor(() => {
      expect(result.current.stage).toBe("failed");
      expect(result.current.error).toBe("RPC timeout");
      expect(result.current.loading).toBe(false);
    });
  });

  it("should reject when wallet not connected", async () => {
    vi.mocked(useWallet).mockReturnValue({
      publicKey: null,
      signTransaction: vi.fn(),
      walletType: null,
      connected: false,
      connecting: false,
      error: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
    });

    const { result } = renderHook(() => useClaim());

    await act(async () => {
      await result.current.submit(1);
    });

    expect(result.current.error).toBe("Wallet not connected");
    expect(result.current.loading).toBe(false);
  });

  it("should reset state on reset()", async () => {
    const mockResult: TransactionResult = { success: true, txHash: "tx123" };
    vi.mocked(claim).mockResolvedValue(mockResult);

    const { result } = renderHook(() => useClaim());

    await act(async () => {
      await result.current.submit(1);
    });

    expect(result.current.result).not.toBeNull();

    act(() => {
      result.current.reset();
    });

    expect(result.current.result).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.stage).toBe("idle");
  });

  it("should pass correct market ID to claim service", async () => {
    const mockResult: TransactionResult = { success: true, txHash: "tx123" };
    vi.mocked(claim).mockResolvedValue(mockResult);

    const { result } = renderHook(() => useClaim());

    await act(async () => {
      await result.current.submit(42);
    });

    expect(claim).toHaveBeenCalledWith(
      "GTEST123...",
      42,
      expect.any(Function)
    );
  });

  it("should handle app error with details", async () => {
    const appError = {
      type: "ContractError",
      message: "Already claimed",
      details: "Entry already marked as claimed",
    };

    vi.mocked(claim).mockRejectedValue(appError);

    const { result } = renderHook(() => useClaim());

    await act(async () => {
      await result.current.submit(1);
    });

    await waitFor(() => {
      expect(result.current.error).toContain("Already claimed");
      expect(result.current.error).toContain("Entry already marked");
    });
  });

  it("should track loading state correctly", async () => {
    let resolveSubmit: (value: TransactionResult) => void;
    const submitPromise = new Promise<TransactionResult>(resolve => {
      resolveSubmit = resolve;
    });

    vi.mocked(claim).mockReturnValue(submitPromise);

    const { result } = renderHook(() => useClaim());

    expect(result.current.loading).toBe(false);

    act(() => {
      result.current.submit(1);
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(true);
    });

    act(() => {
      resolveSubmit({ success: true, txHash: "tx123" });
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
  });
});
