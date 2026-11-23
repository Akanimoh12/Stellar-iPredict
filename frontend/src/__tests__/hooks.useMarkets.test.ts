import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useMarkets } from "@/hooks/useMarkets";
import type { Market } from "@/types";

// Mock dependencies
vi.mock("@/services/market", () => ({
  getMarkets: vi.fn(),
}));

vi.mock("@/hooks/useVisiblePoll", () => ({
  useVisiblePoll: vi.fn(),
}));

vi.mock("@/services/cache", () => ({
  getStale: vi.fn(() => null),
}));

import { getMarkets } from "@/services/market";

const mockMarkets: Market[] = [
  {
    id: 1,
    title: "BTC above $50k?",
    description: "Bitcoin price",
    category: "Crypto",
    totalYes: 100,
    totalNo: 50,
    endTime: Math.floor(Date.now() / 1000) + 86400,
    resolved: false,
    cancelled: false,
    betCount: 10,
    createdAt: Date.now(),
  },
  {
    id: 2,
    title: "Will it rain tomorrow?",
    description: "Weather forecast",
    category: "Science",
    totalYes: 20,
    totalNo: 30,
    endTime: Math.floor(Date.now() / 1000) + 86400 * 2,
    resolved: false,
    cancelled: false,
    betCount: 5,
    createdAt: Date.now(),
  },
];

describe("useMarkets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getMarkets).mockResolvedValue(mockMarkets);
  });

  it("should fetch and return markets", async () => {
    const { result } = renderHook(() => useMarkets());

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.data.map((market) => market.id)).toEqual([2, 1]);
    });
  });

  it("should handle fetch error", async () => {
    const error = new Error("Network error");
    vi.mocked(getMarkets).mockRejectedValue(error);

    const { result } = renderHook(() => useMarkets());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBe("Network error");
    });
  });

  it("should filter markets by active status", async () => {
    const { result } = renderHook(() => useMarkets("active"));

    await waitFor(() => {
      expect(result.current.data.length).toBe(2);
      expect(result.current.data.every((m) => !m.resolved && !m.cancelled)).toBe(true);
    });
  });

  it("should filter markets by resolved status", async () => {
    const resolvedMarkets = [
      { ...mockMarkets[0], resolved: true },
      { ...mockMarkets[1], resolved: false },
    ];
    vi.mocked(getMarkets).mockResolvedValue(resolvedMarkets);

    const { result } = renderHook(() => useMarkets("resolved"));

    await waitFor(() => {
      expect(result.current.data.length).toBe(1);
      expect(result.current.data[0].resolved).toBe(true);
    });
  });

  it("should filter markets by category", async () => {
    const { result } = renderHook(() => useMarkets("crypto"));

    await waitFor(() => {
      expect(result.current.data.length).toBe(1);
      expect(result.current.data[0].category).toBe("Crypto");
    });
  });

  it("should sort markets by volume", async () => {
    const { result } = renderHook(() => useMarkets("all", "volume"));

    await waitFor(() => {
      const volumes = result.current.data.map((m) => m.totalYes + m.totalNo);
      for (let i = 0; i < volumes.length - 1; i++) {
        expect(volumes[i]).toBeGreaterThanOrEqual(volumes[i + 1]);
      }
    });
  });

  it("should sort markets by newest", async () => {
    const { result } = renderHook(() => useMarkets("all", "newest"));

    await waitFor(() => {
      for (let i = 0; i < result.current.data.length - 1; i++) {
        expect(result.current.data[i].id).toBeGreaterThanOrEqual(
          result.current.data[i + 1].id
        );
      }
    });
  });

  it("should sort markets by ending_soon", async () => {
    const { result } = renderHook(() => useMarkets("all", "ending_soon"));

    await waitFor(() => {
      for (let i = 0; i < result.current.data.length - 1; i++) {
        expect(result.current.data[i].endTime).toBeLessThanOrEqual(
          result.current.data[i + 1].endTime
        );
      }
    });
  });

  it("should sort markets by bettors count", async () => {
    const { result } = renderHook(() => useMarkets("all", "bettors"));

    await waitFor(() => {
      for (let i = 0; i < result.current.data.length - 1; i++) {
        expect(result.current.data[i].betCount).toBeGreaterThanOrEqual(
          result.current.data[i + 1].betCount
        );
      }
    });
  });

  it("should handle filter changes", async () => {
    const { result, rerender } = renderHook(
      ({ filter }) => useMarkets(filter),
      { initialProps: { filter: "all" as const } }
    );

    await waitFor(() => {
      expect(result.current.data.length).toBeGreaterThan(0);
    });

    rerender({ filter: "crypto" as const });

    await waitFor(() => {
      expect(result.current.data.every((m) => m.category === "Crypto")).toBe(true);
    });
  });

  it("should refetch on demand", async () => {
    const { result } = renderHook(() => useMarkets());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(getMarkets).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.refetch();
    });

    await waitFor(() => {
      expect(getMarkets).toHaveBeenCalledTimes(2);
    });
  });

  it("should handle ending_soon filter correctly", async () => {
    const now = Date.now();
    const marketsWithTimes: Market[] = [
      {
        ...mockMarkets[0],
        endTime: Math.floor(now / 1000) + 12 * 60 * 60, // 12 hours
      },
      {
        ...mockMarkets[1],
        endTime: Math.floor(now / 1000) + 48 * 60 * 60, // 48 hours
      },
    ];
    vi.mocked(getMarkets).mockResolvedValue(marketsWithTimes);

    const { result } = renderHook(() => useMarkets("ending_soon"));

    await waitFor(() => {
      expect(result.current.data.length).toBe(1);
      expect(result.current.data[0].endTime).toBe(
        marketsWithTimes[0].endTime
      );
    });
  });

  it("should combine filter and sort", async () => {
    const { result } = renderHook(() =>
      useMarkets("crypto", "volume")
    );

    await waitFor(() => {
      expect(result.current.data.every((m) => m.category === "Crypto")).toBe(true);
      const volumes = result.current.data.map((m) => m.totalYes + m.totalNo);
      for (let i = 0; i < volumes.length - 1; i++) {
        expect(volumes[i]).toBeGreaterThanOrEqual(volumes[i + 1]);
      }
    });
  });
});
