import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const signTransaction = vi.fn();
const refetch = vi.fn();
const registerReferral = vi.fn();
const resolveAddressByName = vi.fn();
const writeText = vi.fn().mockResolvedValue(undefined);

let walletState = {
  publicKey: "GUSER" as string | null,
  signTransaction,
};

let referralState = {
  data: {
    referrer: null,
    displayName: "alice",
    referralCount: 3,
    earnings: 250000000,
    isRegistered: true,
  },
  loading: false,
  refetch,
};

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => walletState,
}));

vi.mock("@/hooks/useReferral", () => ({
  useReferral: () => referralState,
}));

vi.mock("@/services/referral", () => ({
  registerReferral,
  resolveAddressByName,
}));

import PointsCard from "@/components/profile/PointsCard";
import ReferralStats from "@/components/profile/ReferralStats";

describe("PointsCard", () => {
  it("formats points, win rate, and bet counts", () => {
    render(<PointsCard points={12345} winRate={67.8} totalBets={20} wonBets={14} />);

    expect(screen.getByText("12,345")).toBeInTheDocument();
    expect(screen.getByText("68% win rate")).toBeInTheDocument();
    expect(screen.getByText("Total Bets")).toBeInTheDocument();
    expect(screen.getByText("20")).toBeInTheDocument();
    expect(screen.getByText("Won")).toBeInTheDocument();
    expect(screen.getByText("14")).toBeInTheDocument();
  });

  it("renders invalid numeric props as zero", () => {
    render(<PointsCard points={Number.NaN} winRate={Number.NaN} />);

    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("0% win rate")).toBeInTheDocument();
  });
});

describe("ReferralStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, { clipboard: { writeText } });
    walletState = { publicKey: "GUSER", signTransaction };
    referralState = {
      data: {
        referrer: null,
        displayName: "alice",
        referralCount: 3,
        earnings: 250000000,
        isRegistered: true,
      },
      loading: false,
      refetch,
    };
  });

  it("shows registered referral data", () => {
    render(<ReferralStats />);

    expect(screen.getByRole("heading", { name: "Referrals" })).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("25.00 XLM")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
  });

  it("copies the referral name", async () => {
    render(<ReferralStats />);

    fireEvent.click(screen.getByTitle("Copy referral name"));

    expect(writeText).toHaveBeenCalledWith("alice");
  });

  it("asks disconnected users to connect a wallet", () => {
    walletState = { publicKey: null, signTransaction };
    render(<ReferralStats />);

    expect(screen.getByText(/Connect your wallet to view referral stats/)).toBeInTheDocument();
  });
});
