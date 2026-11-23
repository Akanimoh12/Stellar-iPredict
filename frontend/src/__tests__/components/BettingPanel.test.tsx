import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import React from "react";
import type { Market, Bet } from "@/types";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockSignTransaction = vi.fn();

let walletState = {
  publicKey: "GABCD1234EFGH5678IJKL" as string | null,
  connected: true,
  connecting: false,
  error: null as null,
  connect: mockConnect,
  disconnect: mockDisconnect,
  signTransaction: mockSignTransaction,
  walletType: null as null,
};

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => walletState,
}));

const mockSubmit = vi.fn();
const mockReset = vi.fn();

let betState = {
  submit: mockSubmit,
  result: null as null,
  loading: false,
  stage: "idle" as string,
  error: null as string | null,
  reset: mockReset,
};

vi.mock("@/hooks/useBet", () => ({
  useBet: () => betState,
}));

// Stub ShareBetButton
vi.mock("@/components/social/ShareBetButton", () => ({
  default: () => <button data-testid="share-btn">Share</button>,
}));

// Stub TxProgress
vi.mock("@/components/ui/TxProgress", () => ({
  default: ({ step }: { step: string }) => (
    <div data-testid="tx-progress">{step}</div>
  ),
}));

import BettingPanel from "@/components/market/BettingPanel";

// ── Fixtures ───────────────────────────────────────────────────────────────

const mockMarket: Market = {
  id: 1,
  question: "Will BTC hit 100k?",
  imageUrl: "",
  category: "Crypto",
  endTime: Math.floor(Date.now() / 1000) + 86400,
  totalYes: 500,
  totalNo: 300,
  resolved: false,
  outcome: false,
  cancelled: false,
  creator: "GABCD",
  betCount: 10,
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("BettingPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    walletState = {
      publicKey: "GABCD1234EFGH5678IJKL",
      connected: true,
      connecting: false,
      error: null,
      connect: mockConnect,
      disconnect: mockDisconnect,
      signTransaction: mockSignTransaction,
      walletType: null,
    };
    betState = {
      submit: mockSubmit,
      result: null,
      loading: false,
      stage: "idle",
      error: null,
      reset: mockReset,
    };
  });

  it("renders amount input", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={100} />);
    expect(screen.getByPlaceholderText("0.00")).toBeInTheDocument();
  });

  it("renders yes and no buttons with odds", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={100} />);
    expect(screen.getByText(/YES/)).toBeInTheDocument();
    expect(screen.getByText(/NO/)).toBeInTheDocument();
  });

  it("renders Place Bet button when no existing bet", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={100} />);
    expect(screen.getByText("Place Bet")).toBeInTheDocument();
  });

  it("renders quick amount buttons", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={100} />);
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("50")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("MAX")).toBeInTheDocument();
  });

  it("shows balance", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={42.5} />);
    expect(screen.getByText(/42\.50 XLM/)).toBeInTheDocument();
  });

  it("shows 'Connect Wallet' when not connected", () => {
    walletState = { ...walletState, publicKey: null, connected: false };
    render(<BettingPanel market={mockMarket} userBet={null} balance={0} />);
    expect(screen.getByText("Connect Wallet")).toBeInTheDocument();
  });

  it("shows 'Market Closed' for resolved market", () => {
    const resolved = { ...mockMarket, resolved: true };
    render(<BettingPanel market={resolved} userBet={null} balance={100} />);
    expect(screen.getByText("Market Closed")).toBeInTheDocument();
  });

  it("shows 'Increase Position' with existing bet", () => {
    const existingBet: Bet = { amount: 10, isYes: true, claimed: false };
    render(
      <BettingPanel market={mockMarket} userBet={existingBet} balance={100} />
    );
    expect(screen.getByText("Increase Position")).toBeInTheDocument();
  });

  it("displays existing position info when user has a bet", () => {
    const existingBet: Bet = { amount: 25, isYes: true, claimed: false };
    render(
      <BettingPanel market={mockMarket} userBet={existingBet} balance={100} />
    );
    expect(screen.getByText(/Your position/)).toBeInTheDocument();
    expect(screen.getByText(/25\.00 XLM on YES/)).toBeInTheDocument();
  });

  it("shows minimum bet validation", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={100} />);
    const input = screen.getByPlaceholderText("0.00");
    fireEvent.change(input, { target: { value: "0.5" } });
    expect(screen.getByText(/Minimum bet is 1 XLM/)).toBeInTheDocument();
  });

  it("shows insufficient balance validation", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={5} />);
    const input = screen.getByPlaceholderText("0.00");
    fireEvent.change(input, { target: { value: "10" } });
    expect(screen.getByText(/Insufficient balance/)).toBeInTheDocument();
  });

  it("rejects a bet that exceeds the spendable balance (reserve-aware)", () => {
    // Regression: a wallet with 1.5 XLM has ~0.3 bettable after the ~1.2 reserve
    // buffer. Betting 1 XLM must be flagged insufficient — this is the exact
    // case that previously trapped on-chain with Error(Contract, #10).
    render(<BettingPanel market={mockMarket} userBet={null} balance={1.5} />);
    const input = screen.getByPlaceholderText("0.00");
    fireEvent.change(input, { target: { value: "1" } });
    expect(screen.getByText(/Insufficient balance/)).toBeInTheDocument();
  });

  it("shows the reserve-aware bettable amount alongside the balance", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={10} />);
    // 10 total − 1.2 reserve = 8.80 bettable
    expect(screen.getByText(/8\.80 bettable/)).toBeInTheDocument();
  });

  it("MAX button respects the reserve (does not set full balance)", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={10} />);
    fireEvent.click(screen.getByText("MAX"));
    const input = screen.getByPlaceholderText("0.00") as HTMLInputElement;
    // floor(10 − 1.2) = 8, never the full 10
    expect(input.value).toBe("8");
  });

  it("shows payout calculator when amount entered", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={100} />);
    const input = screen.getByPlaceholderText("0.00");
    fireEvent.change(input, { target: { value: "10" } });
    expect(screen.getByText(/If you win/)).toBeInTheDocument();
    expect(screen.getByText(/Platform fee/)).toBeInTheDocument();
    expect(screen.getByText(/Network fee/)).toBeInTheDocument();
  });

  it("warns about the one-time first-bet storage fee (no existing bet)", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={100} />);
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "10" } });
    expect(screen.getByText(/first bet on a market includes a one-time/i)).toBeInTheDocument();
    expect(screen.getByText(/~0.14 XLM first bet/)).toBeInTheDocument();
  });

  it("shows cheap network fee when increasing an existing position", () => {
    const existingBet: Bet = { amount: 10, isYes: true, claimed: false };
    render(<BettingPanel market={mockMarket} userBet={existingBet} balance={100} />);
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "10" } });
    expect(screen.getByText(/~0.003 XLM/)).toBeInTheDocument();
    // No first-bet warning when a position already exists.
    expect(screen.queryByText(/first bet on a market includes a one-time/i)).toBeNull();
  });

  it("quick amount button sets input value", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={100} />);
    fireEvent.click(screen.getByText("5"));
    const input = screen.getByPlaceholderText("0.00") as HTMLInputElement;
    expect(input.value).toBe("5");
  });

  it("prevents double submission on rapid clicks", async () => {
    let resolveSubmit: () => void;
    const submitPromise = new Promise<void>((resolve) => {
      resolveSubmit = resolve;
    });
    mockSubmit.mockImplementation(() => submitPromise);

    render(<BettingPanel market={mockMarket} userBet={null} balance={100} />);
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "10" } });

    fireEvent.click(screen.getByRole("button", { name: "Place Bet" }));
    const confirmBtn = screen.getByRole("button", { name: "Confirm & sign" });
    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn);

    expect(mockSubmit).toHaveBeenCalledTimes(1);
    resolveSubmit!();
  });
});

// ── Confirmation step before signing (#852) ─────────────────────────────────

describe("BettingPanel confirmation step (#852)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSubmit.mockResolvedValue(undefined);
    betState = {
      submit: mockSubmit,
      result: null,
      loading: false,
      stage: "idle",
      error: null,
      reset: mockReset,
    };
  });

  it("does not open the wallet until the bet is confirmed", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={100} />);
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Place Bet" }));
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("summarises side, amount, fee and expected payout before signing", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={100} />);
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Place Bet" }));

    const dialog = screen.getByRole("dialog", { name: "Confirm your bet" });
    expect(within(dialog).getByText("YES")).toBeInTheDocument();
    expect(within(dialog).getByText("10.00 XLM")).toBeInTheDocument();
    expect(within(dialog).getByText("0.20 XLM")).toBeInTheDocument();
    expect(within(dialog).getByText(/Expected payout if you win/)).toBeInTheDocument();
  });

  it("confirming submits the reviewed bet with the same side and amount", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={100} />);
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Place Bet" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm & sign" }));
    expect(mockSubmit).toHaveBeenCalledWith(mockMarket.id, true, 10);
  });

  it("cancel returns to the form without submitting", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={100} />);
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Place Bet" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Confirm your bet" })).toBeNull();
    expect(screen.getByRole("button", { name: "Place Bet" })).toBeInTheDocument();
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("changing the amount after reviewing clears the confirmation", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={100} />);
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Place Bet" }));
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "20" } });
    expect(screen.queryByRole("dialog", { name: "Confirm your bet" })).toBeNull();
  });
});
