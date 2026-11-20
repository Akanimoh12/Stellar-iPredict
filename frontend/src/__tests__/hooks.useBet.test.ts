import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useBet } from "@/hooks/useBet";
import type { TransactionResult } from "@/types";

// Mock dependencies
vi.mock("@/hooks/useWallet", () => ({
  useWallet: vi.fn(() => ({
    publicKey: "GTEST123...",
    signTransaction: vi.fn().mockResolvedValue("signed_xdr"),
  })),
}));

vi.mock("@/services/market", () => ({
  placeBet: vi.fn(),
}));

import { placeBet } from "@/services/market";
import { useWallet } from "@/hooks/useWallet";

describe("useBet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should initialize with idle state", () => {
    const { result } = renderHook(() => useBet());

    expect(result.current.loading).toBe(false);
    expect(result.current.stage).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(result.current.result).toBeNull();
  });

  it("should handle successful bet submission", async () => {
    const mockResult: TransactionResult = {
      success: true,
      txHash: "tx123",
      timestamp: Date.now(),
    };

    vi.mocked(placeBet).mockResolvedValue(mockResult);

    const { result } = renderHook(() => useBet());

    await act(async () => {
      await result.current.submit(1, true, 100);
    });

    await waitFor(() => {
      expect(result.current.stage).toBe("confirmed");
      expect(result.current.result).toEqual(mockResult);
      expect(result.current.error).toBeNull();
      expect(result.current.loading).toBe(false);
    });
  });

  it("should handle failed bet submission", async () => {
    const mockResult: TransactionResult = {
      success: false,
      error: "Insufficient balance",
    };

    vi.mocked(placeBet).mockResolvedValue(mockResult);

    const { result } = renderHook(() => useBet());

    await act(async () => {
      await result.current.submit(1, true, 100);
    });

    await waitFor(() => {
      expect(result.current.stage).toBe("failed");
      expect(result.current.error).toBe("Insufficient balance");
      expect(result.current.loading).toBe(false);
    });
  });

  it("should handle exception during submission", async () => {
    const error = new Error("Network error");
    vi.mocked(placeBet).mockRejectedValue(error);

    const { result } = renderHook(() => useBet());

    await act(async () => {
      await result.current.submit(1, true, 100);
    });

    await waitFor(() => {
      expect(result.current.stage).toBe("failed");
      expect(result.current.error).toBe("Network error");
      expect(result.current.loading).toBe(false);
    });
  });

  it("should reject submission when wallet not connected", async () => {
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

    const { result } = renderHook(() => useBet());

    await act(async () => {
      await result.current.submit(1, true, 100);
    });

    expect(result.current.error).toBe("Wallet not connected");
    expect(result.current.loading).toBe(false);
  });

  it("should cycle through transaction stages", async () => {
    const stages: string[] = [];
    const mockResult: TransactionResult = { success: true, txHash: "tx123" };

    vi.mocked(placeBet).mockResolvedValue(mockResult);

    const { result } = renderHook(() => useBet());

    await act(async () => {
      const promise = result.current.submit(1, true, 100);
      // Capture stages as hook updates
      stages.push(result.current.stage);
      await promise;
    });

    expect(stages[0]).toBe("idle");
    expect(result.current.stage).toBe("confirmed");
  });

  it("should reset state on reset()", async () => {
    const mockResult: TransactionResult = { success: true, txHash: "tx123" };
    vi.mocked(placeBet).mockResolvedValue(mockResult);

    const { result } = renderHook(() => useBet());

    await act(async () => {
      await result.current.submit(1, true, 100);
    });

    expect(result.current.result).not.toBeNull();

    act(() => {
      result.current.reset();
    });

    expect(result.current.result).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.stage).toBe("idle");
  });

  it("should handle app error format", async () => {
    const appError = {
      type: "ContractError",
      message: "Market expired",
      details: "Market ended at 1700000000, current time 1700100000",
    };

    vi.mocked(placeBet).mockRejectedValue(appError);

    const { result } = renderHook(() => useBet());

    await act(async () => {
      await result.current.submit(1, true, 100);
    });

    await waitFor(() => {
      expect(result.current.error).toContain("Market expired");
      expect(result.current.error).toContain("Market ended at");
    });
  });

  it("should pass correct parameters to placeBet", async () => {
    const mockResult: TransactionResult = { success: true, txHash: "tx123" };
    vi.mocked(placeBet).mockResolvedValue(mockResult);

    const { result } = renderHook(() => useBet());

    await act(async () => {
      await result.current.submit(42, false, 50.5);
    });

    expect(placeBet).toHaveBeenCalledWith(
      "GTEST123...",
      42,
      false,
      50.5,
      expect.any(Function)
    );
  });
});
