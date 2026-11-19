import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const signTransaction = vi.fn();
const withdrawFees = vi.fn();
const addResolver = vi.fn();
const removeResolver = vi.fn();
const addFeeRecipient = vi.fn();
const getAccumulatedFees = vi.fn();
const getMarkets = vi.fn();

let walletState = {
  publicKey: "GADMIN" as string | null,
  signTransaction,
};

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => walletState,
}));

vi.mock("@/services/market", () => ({
  getAccumulatedFees,
  getMarkets,
  withdrawFees,
  addResolver,
  removeResolver,
  addFeeRecipient,
}));

import PlatformStats from "@/components/admin/PlatformStats";

const now = Math.floor(Date.now() / 1000);

function market(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    question: `Market ${id}`,
    imageUrl: "",
    category: "Crypto",
    endTime: now + 3600,
    totalYes: 10,
    totalNo: 5,
    resolved: false,
    outcome: false,
    cancelled: false,
    creator: "GCREATOR",
    betCount: 1,
    ...overrides,
  };
}

describe("PlatformStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    walletState = { publicKey: "GADMIN", signTransaction };
    getAccumulatedFees.mockResolvedValue(12.5);
    getMarkets.mockResolvedValue([
      market(1),
      market(2, { endTime: now - 3600, resolved: true, outcome: true }),
      market(3, { cancelled: true, totalYes: 7, totalNo: 3 }),
    ]);
    withdrawFees.mockResolvedValue({ success: true });
  });

  it("summarizes market and fee data", async () => {
    render(<PlatformStats />);

    expect(await screen.findByText("Platform Stats")).toBeInTheDocument();
    expect(screen.getAllByText("12.5000 XLM")).toHaveLength(2);
    expect(screen.getByText("25.00 XLM")).toBeInTheDocument();
    expect(screen.getByText("Resolver Management")).toBeInTheDocument();
    expect(screen.getByText("Fee Recipients")).toBeInTheDocument();
  });

  it("shows withdraw failures returned by the service", async () => {
    withdrawFees.mockResolvedValueOnce({ success: false, error: "Not authorized" });
    render(<PlatformStats />);

    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));

    await waitFor(() => {
      expect(withdrawFees).toHaveBeenCalledWith("GADMIN", "GADMIN", signTransaction);
    });
    expect(await screen.findByText("Not authorized")).toBeInTheDocument();
  });
});
