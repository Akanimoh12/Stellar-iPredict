import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import React from "react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Market, Bet } from "@/types";
import { MIN_BET_XLM, MAX_BETS_PER_USER } from "@/config/network";

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

// ── Balance loading, max-bet clamp and one-side-per-market (#848 #849 #850) ──

const yesBet: Bet = { amount: 10, isYes: true, claimed: false };
const noBet: Bet = { amount: 10, isYes: false, claimed: false };

function resetPanelMocks() {
  vi.clearAllMocks();
  mockSubmit.mockResolvedValue(undefined);
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
}

function typeAmount(value: string) {
  fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value } });
}

describe("BettingPanel while the balance is loading (#848)", () => {
  beforeEach(resetPanelMocks);

  it("disables the bet button and says why, even with a valid amount", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={100} balanceLoading />);
    typeAmount("10");

    const button = screen.getByRole("button", { name: "Loading balance…" });
    expect(button).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Place Bet" })).toBeNull();
  });

  it("does not open the confirmation or the wallet when clicked", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={100} balanceLoading />);
    typeAmount("10");

    fireEvent.click(screen.getByRole("button", { name: "Loading balance…" }));

    expect(screen.queryByRole("dialog", { name: "Confirm your bet" })).toBeNull();
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("shows that the balance is loading instead of a number", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={0} balanceLoading />);

    expect(screen.getByText("Balance: loading…")).toBeInTheDocument();
    expect(screen.queryByText(/0\.00 XLM/)).toBeNull();
    expect(screen.queryByText(/bettable/)).toBeNull();
  });

  it("does not show the not-enough-balance hint while the balance is unknown", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={0} balanceLoading />);

    expect(screen.queryByText(/Not enough bettable XLM/)).toBeNull();
  });

  it("holds the MAX button until the balance arrives", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={100} balanceLoading />);

    expect(screen.getByRole("button", { name: "MAX" })).toBeDisabled();
  });

  it("enables betting once the balance has loaded", () => {
    const { rerender } = render(
      <BettingPanel market={mockMarket} userBet={null} balance={0} balanceLoading />
    );
    expect(screen.getByRole("button", { name: "Loading balance…" })).toBeDisabled();

    rerender(<BettingPanel market={mockMarket} userBet={null} balance={100} balanceLoading={false} />);
    typeAmount("10");

    expect(screen.getByRole("button", { name: "Place Bet" })).toBeEnabled();
    expect(screen.getByText(/100\.00 XLM/)).toBeInTheDocument();
  });

  it("holds betting again when the balance is refreshed after a bet", () => {
    const { rerender } = render(
      <BettingPanel market={mockMarket} userBet={yesBet} balance={100} balanceLoading={false} />
    );
    typeAmount("10");
    expect(screen.getByRole("button", { name: "Increase Position" })).toBeEnabled();

    rerender(<BettingPanel market={mockMarket} userBet={yesBet} balance={100} balanceLoading />);

    expect(screen.getByRole("button", { name: "Loading balance…" })).toBeDisabled();
  });

  it("blocks signing if the balance starts reloading while the bet is being confirmed", () => {
    const { rerender } = render(
      <BettingPanel market={mockMarket} userBet={null} balance={100} balanceLoading={false} />
    );
    typeAmount("10");
    fireEvent.click(screen.getByRole("button", { name: "Place Bet" }));
    expect(screen.getByRole("button", { name: "Confirm & sign" })).toBeEnabled();

    rerender(<BettingPanel market={mockMarket} userBet={null} balance={100} balanceLoading />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm & sign" }));

    expect(screen.getByRole("button", { name: "Confirm & sign" })).toBeDisabled();
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("is not treated as loading when the prop is omitted", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={100} />);
    typeAmount("10");

    expect(screen.getByRole("button", { name: "Place Bet" })).toBeEnabled();
  });

  it("still asks to connect a wallet while loading", () => {
    walletState = { ...walletState, publicKey: null, connected: false };
    render(<BettingPanel market={mockMarket} userBet={null} balance={0} balanceLoading />);

    expect(screen.getByRole("button", { name: "Connect Wallet" })).toBeDisabled();
  });

  it("still reports a closed market while loading", () => {
    render(
      <BettingPanel
        market={{ ...mockMarket, resolved: true }}
        userBet={null}
        balance={100}
        balanceLoading
      />
    );

    expect(screen.getByRole("button", { name: "Market Closed" })).toBeDisabled();
  });
});

describe("BettingPanel max bet clamp (#849)", () => {
  beforeEach(resetPanelMocks);

  const maxInput = () => screen.getByPlaceholderText("0.00") as HTMLInputElement;

  it("mirrors the contract's per-user limits", () => {
    expect(MIN_BET_XLM).toBe(1);
    expect(MAX_BETS_PER_USER).toBe(20);
  });

  it("stays in step with the limits defined in the contract source", () => {
    const contract = resolve(__dirname, "../../../../contracts/prediction_market/src/lib.rs");
    if (!existsSync(contract)) return; // frontend checked out on its own
    const source = readFileSync(contract, "utf8");

    const maxBets = source.match(/const MAX_BETS_PER_USER: u32 = (\d+);/);
    const minBet = source.match(/const MIN_BET: i128 = ([\d_]+);/);
    expect(maxBets).not.toBeNull();
    expect(minBet).not.toBeNull();
    expect(Number(maxBets![1])).toBe(MAX_BETS_PER_USER);
    expect(Number(minBet![1].replace(/_/g, "")) / 10_000_000).toBe(MIN_BET_XLM);
  });

  it("sets MAX to the whole-XLM spendable balance, below the full balance", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={100.9} />);
    fireEvent.click(screen.getByRole("button", { name: "MAX" }));

    // 100.9 - 1.2 reserve = 99.7, floored
    expect(maxInput().value).toBe("99");
  });

  it("a MAX bet is always accepted by the panel's own validation", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={7.35} />);
    fireEvent.click(screen.getByRole("button", { name: "MAX" }));

    expect(screen.queryByText(/Insufficient balance/)).toBeNull();
    expect(screen.queryByText(/Minimum bet is 1 XLM/)).toBeNull();
    expect(screen.getByRole("button", { name: "Place Bet" })).toBeEnabled();
  });

  it("offers MAX when the spendable balance exactly covers the minimum bet", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={2.2} />);

    expect(screen.getByRole("button", { name: "MAX" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "MAX" }));
    expect(maxInput().value).toBe("1");
  });

  it("disables MAX and explains when the spendable balance is below the minimum bet", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={2.1} />);

    const max = screen.getByRole("button", { name: "MAX" });
    expect(max).toBeDisabled();
    fireEvent.click(max);
    expect(maxInput().value).toBe("");
    expect(screen.getByText(/Not enough bettable XLM to cover the 1 XLM minimum bet/)).toBeInTheDocument();
  });

  it("never sets MAX to zero for a wallet inside the reserve", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={1} />);

    expect(screen.getByRole("button", { name: "MAX" })).toBeDisabled();
    expect(maxInput().value).toBe("");
  });

  it("shows how many of the allowed bets have been placed", () => {
    render(<BettingPanel market={mockMarket} userBet={yesBet} balance={100} userBetCount={19} />);

    expect(screen.getByText("19 of 20 bets placed on this market")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still allows the last permitted bet", () => {
    render(<BettingPanel market={mockMarket} userBet={yesBet} balance={100} userBetCount={19} />);
    fireEvent.click(screen.getByRole("button", { name: "MAX" }));

    expect(maxInput().value).toBe("98");
    expect(screen.getByRole("button", { name: "Increase Position" })).toBeEnabled();
  });

  it("stops offering a bet once the per-market limit is reached", () => {
    render(<BettingPanel market={mockMarket} userBet={yesBet} balance={100} userBetCount={20} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "You have reached the limit of 20 bets on this market."
    );
    expect(screen.getByRole("button", { name: "MAX" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Bet limit reached" })).toBeDisabled();
  });

  it("cannot be submitted at the limit even with a valid amount typed", () => {
    render(<BettingPanel market={mockMarket} userBet={yesBet} balance={100} userBetCount={20} />);
    typeAmount("10");

    fireEvent.click(screen.getByRole("button", { name: "Bet limit reached" }));

    expect(screen.queryByRole("dialog", { name: "Confirm your bet" })).toBeNull();
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("treats a count above the limit as reached", () => {
    render(<BettingPanel market={mockMarket} userBet={yesBet} balance={100} userBetCount={25} />);

    expect(screen.getByRole("button", { name: "Bet limit reached" })).toBeDisabled();
  });

  it("shows no bet count before the first bet", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={100} />);

    expect(screen.queryByText(/bets placed on this market/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("BettingPanel one side per market (#850)", () => {
  beforeEach(resetPanelMocks);

  const yesButton = () => screen.getByRole("button", { name: /^YES \(/ });
  const noButton = () => screen.getByRole("button", { name: /^NO \(/ });

  it("explains why NO is locked for a user who holds YES", () => {
    render(<BettingPanel market={mockMarket} userBet={yesBet} balance={100} />);

    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("A market only accepts one side per wallet.");
    expect(note).toHaveTextContent("You hold YES here, so NO is locked and you can only add to YES.");
    expect(noButton()).toBeDisabled();
    expect(yesButton()).toBeEnabled();
  });

  it("explains why YES is locked for a user who holds NO", () => {
    render(<BettingPanel market={mockMarket} userBet={noBet} balance={100} />);

    expect(screen.getByRole("note")).toHaveTextContent(
      "You hold NO here, so YES is locked and you can only add to NO."
    );
    expect(yesButton()).toBeDisabled();
    expect(noButton()).toBeEnabled();
  });

  it("ties the locked side to the explanation for assistive technology", () => {
    render(<BettingPanel market={mockMarket} userBet={yesBet} balance={100} />);

    const note = screen.getByRole("note");
    expect(noButton()).toHaveAttribute("aria-describedby", note.id);
    expect(yesButton()).not.toHaveAttribute("aria-describedby");
  });

  it("shows no explanation and locks nothing before the first bet", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={100} />);

    expect(screen.queryByRole("note")).toBeNull();
    expect(yesButton()).toBeEnabled();
    expect(noButton()).toBeEnabled();
    expect(noButton()).not.toHaveAttribute("aria-describedby");
  });

  it("warns a first-time bettor before signing that the other side will be closed", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={100} />);
    typeAmount("10");
    fireEvent.click(screen.getByRole("button", { name: "Place Bet" }));

    const dialog = screen.getByRole("dialog", { name: "Confirm your bet" });
    expect(within(dialog).getByText(/One side per market/)).toHaveTextContent(
      "after this bet you can add more to YES, but you cannot bet NO on this market"
    );
  });

  it("names the side that will be closed for the side actually chosen", () => {
    render(<BettingPanel market={mockMarket} userBet={null} balance={100} />);
    fireEvent.click(noButton());
    typeAmount("10");
    fireEvent.click(screen.getByRole("button", { name: "Place Bet" }));

    const dialog = screen.getByRole("dialog", { name: "Confirm your bet" });
    expect(within(dialog).getByText(/One side per market/)).toHaveTextContent(
      "after this bet you can add more to NO, but you cannot bet YES on this market"
    );
  });

  it("does not repeat the warning when adding to an existing position", () => {
    render(<BettingPanel market={mockMarket} userBet={yesBet} balance={100} />);
    typeAmount("10");
    fireEvent.click(screen.getByRole("button", { name: "Increase Position" }));

    const dialog = screen.getByRole("dialog", { name: "Confirm your bet" });
    expect(within(dialog).queryByText(/One side per market/)).toBeNull();
  });
});
