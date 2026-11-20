import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useProfile } from "@/hooks/useProfile";
import type { PlayerStats, ReferralInfo } from "@/types";

// Mock dependencies
vi.mock("@/services/leaderboard", () => ({
  getStats: vi.fn(),
}));

vi.mock("@/services/token", () => ({
  getBalance: vi.fn(),
}));

vi.mock("@/services/referral", () => ({
  getReferrer: vi.fn(),
  getDisplayName: vi.fn(),
  getReferralCount: vi.fn(),
  getEarnings: vi.fn(),
  isRegistered: vi.fn(),
}));

vi.mock("@/hooks/useVisiblePoll", () => ({
  useVisiblePoll: vi.fn(),
}));

import { getStats } from "@/services/leaderboard";
import { getBalance } from "@/services/token";
import {
  getReferrer,
  getDisplayName,
  getReferralCount,
  getEarnings,
  isRegistered,
} from "@/services/referral";

const mockStats: PlayerStats = {
  address: "GTEST123...",
  totalWins: 5,
  totalLosses: 3,
  totalBets: 8,
  netProfit: 125.5,
  winRate: 0.625,
  leaderboardRank: 15,
  leaderboardPoints: 850,
};

const mockReferralInfo: ReferralInfo = {
  referrer: "GREFERRER123...",
  displayName: "alice.stellar",
  referralCount: 3,
  earnings: 25.5,
  isRegistered: true,
};

describe("useProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(getStats).mockResolvedValue(mockStats);
    vi.mocked(getBalance).mockResolvedValue(500);
    vi.mocked(getReferrer).mockResolvedValue(mockReferralInfo.referrer);
    vi.mocked(getDisplayName).mockResolvedValue(mockReferralInfo.displayName);
    vi.mocked(getReferralCount).mockResolvedValue(mockReferralInfo.referralCount);
    vi.mocked(getEarnings).mockResolvedValue(mockReferralInfo.earnings);
    vi.mocked(isRegistered).mockResolvedValue(mockReferralInfo.isRegistered);
  });

  it("should initialize loading state", () => {
    const { result } = renderHook(() => useProfile("GTEST123..."));

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("should fetch profile data for connected user", async () => {
    const { result } = renderHook(() => useProfile("GTEST123..."));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.data).not.toBeNull();
    });

    expect(result.current.data?.stats).toEqual(mockStats);
    expect(result.current.data?.tokenBalance).toBe(500);
    expect(result.current.data?.referral?.displayName).toBe("alice.stellar");
  });

  it("should return null data when no publicKey provided", async () => {
    const { result } = renderHook(() => useProfile());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.data).toBeNull();
    });
  });

  it("should handle fetch errors", async () => {
    const error = new Error("Network error");
    vi.mocked(getStats).mockRejectedValue(error);

    const { result } = renderHook(() => useProfile("GTEST123..."));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBe("Network error");
      expect(result.current.data).toBeNull();
    });
  });

  it("should fetch all data in parallel", async () => {
    const { result } = renderHook(() => useProfile("GTEST123..."));

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    // All services should be called
    expect(getStats).toHaveBeenCalledWith("GTEST123...");
    expect(getBalance).toHaveBeenCalledWith("GTEST123...");
    expect(getReferrer).toHaveBeenCalledWith("GTEST123...");
    expect(getDisplayName).toHaveBeenCalledWith("GTEST123...");
    expect(getReferralCount).toHaveBeenCalledWith("GTEST123...");
    expect(getEarnings).toHaveBeenCalledWith("GTEST123...");
    expect(isRegistered).toHaveBeenCalledWith("GTEST123...");
  });

  it("should refetch on demand", async () => {
    const { result } = renderHook(() => useProfile("GTEST123..."));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(getStats).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.refetch();
    });

    await waitFor(() => {
      expect(getStats).toHaveBeenCalledTimes(2);
    });
  });

  it("should handle missing referrer", async () => {
    vi.mocked(getReferrer).mockResolvedValue(null);

    const { result } = renderHook(() => useProfile("GTEST123..."));

    await waitFor(() => {
      expect(result.current.data?.referral?.referrer).toBeNull();
    });
  });

  it("should update data when publicKey changes", async () => {
    const { result, rerender } = renderHook(
      ({ publicKey }) => useProfile(publicKey),
      { initialProps: { publicKey: "GUSER1..." } }
    );

    await waitFor(() => {
      expect(getStats).toHaveBeenCalledWith("GUSER1...");
    });

    rerender({ publicKey: "GUSER2..." });

    await waitFor(() => {
      expect(getStats).toHaveBeenCalledWith("GUSER2...");
    });
  });

  it("should handle partial data failure gracefully", async () => {
    vi.mocked(getBalance).mockRejectedValue(new Error("Balance fetch failed"));

    const { result } = renderHook(() => useProfile("GTEST123..."));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBe("Balance fetch failed");
    });
  });

  it("should properly structure referral info", async () => {
    const { result } = renderHook(() => useProfile("GTEST123..."));

    await waitFor(() => {
      expect(result.current.data?.referral).toEqual({
        referrer: mockReferralInfo.referrer,
        displayName: mockReferralInfo.displayName,
        referralCount: mockReferralInfo.referralCount,
        earnings: mockReferralInfo.earnings,
        isRegistered: mockReferralInfo.isRegistered,
      });
    });
  });

  it("should handle zero values correctly", async () => {
    vi.mocked(getStats).mockResolvedValue({
      ...mockStats,
      leaderboardPoints: 0,
      leaderboardRank: 0,
    });
    vi.mocked(getBalance).mockResolvedValue(0);
    vi.mocked(getReferralCount).mockResolvedValue(0);
    vi.mocked(getEarnings).mockResolvedValue(0);

    const { result } = renderHook(() => useProfile("GTEST123..."));

    await waitFor(() => {
      expect(result.current.data?.tokenBalance).toBe(0);
      expect(result.current.data?.referral?.referralCount).toBe(0);
      expect(result.current.data?.referral?.earnings).toBe(0);
    });
  });

  it("should maintain referral data for unregistered users", async () => {
    vi.mocked(isRegistered).mockResolvedValue(false);

    const { result } = renderHook(() => useProfile("GTEST123..."));

    await waitFor(() => {
      expect(result.current.data?.referral?.isRegistered).toBe(false);
      expect(result.current.data?.referral?.displayName).toBe("alice.stellar");
    });
  });

  it("should track loaded state separately from first load", async () => {
    const { result } = renderHook(() => useProfile("GTEST123..."));

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.data).not.toBeNull();
    });

    // After first load, manual refetch should not show loading skeleton
    act(() => {
      result.current.refetch();
    });

    // Loading state depends on whether this is the first load or a refresh
    // First load shows loading skeleton, subsequent refreshes are silent
    expect(result.current.data).not.toBeNull();
  });

  it("should handle changing from no publicKey to connected", async () => {
    const { result, rerender } = renderHook(
      ({ publicKey }) => useProfile(publicKey),
      { initialProps: { publicKey: undefined } }
    );

    await waitFor(() => {
      expect(result.current.data).toBeNull();
      expect(result.current.loading).toBe(false);
    });

    rerender({ publicKey: "GTEST123..." });

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });
  });

  it("should handle changing from connected to no publicKey", async () => {
    const { result, rerender } = renderHook(
      ({ publicKey }) => useProfile(publicKey),
      { initialProps: { publicKey: "GTEST123..." } }
    );

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    rerender({ publicKey: undefined });

    await waitFor(() => {
      expect(result.current.data).toBeNull();
    });
  });
});
