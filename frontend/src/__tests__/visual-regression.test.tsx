import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Market, PlayerStats } from "@/types";

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => <img {...props} alt={String(props.alt ?? "")} />,
}));

vi.mock("@/components/market/MarketImage", () => ({
  default: ({ alt }: { alt: string }) => <div data-testid="market-image">{alt}</div>,
}));

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({ publicKey: null, connected: false }),
}));

vi.mock("@/hooks/useBet", () => ({
  useBet: () => ({
    submit: vi.fn(),
    result: null,
    loading: false,
    stage: "idle",
    error: null,
    reset: vi.fn(),
  }),
}));

vi.mock("@/hooks/useToast", () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

import MarketCard from "@/components/market/MarketCard";
import BettingPanel from "@/components/market/BettingPanel";
import LeaderboardTable from "@/components/leaderboard/LeaderboardTable";

const market: Market = {
  id: 42,
  question: "Will BTC reach $100k?",
  imageUrl: "/test.png",
  category: "Crypto",
  endTime: 4102444800,
  totalYes: 500,
  totalNo: 300,
  resolved: false,
  outcome: false,
  cancelled: false,
  creator: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQ",
  betCount: 10,
};

const players: PlayerStats[] = [
  { address: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQ", displayName: "Alice", points: 1500, wonBets: 10, lostBets: 3, totalBets: 13, winRate: 76.9 },
  { address: "GXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCD", displayName: "Bob", points: 900, wonBets: 7, lostBets: 5, totalBets: 12, winRate: 58.3 },
];

describe("key screen visual regression guards", () => {
  it("preserves the market card layout", () => {
    const { container, getByRole } = render(<MarketCard market={market} />);
    const card = container.firstElementChild;
    expect(card).toHaveClass("rounded-2xl", "overflow-hidden");
    expect(getByRole("heading", { level: 3 })).toHaveClass("line-clamp-2");
  });

  it("preserves the betting panel layout", () => {
    const { container, getByText } = render(<BettingPanel market={market} userBet={null} balance={25} />);
    expect(container.firstElementChild).toHaveClass("card", "space-y-5");
    expect(getByText("Place Your Bet")).toBeInTheDocument();
    expect(container.querySelector(".grid.grid-cols-2")).not.toBeNull();
  });

  it("preserves the leaderboard layout", () => {
    const { container, getByText } = render(<LeaderboardTable players={players} currentUser={players[0].address} />);
    expect(getByText("Your Rank")).toBeInTheDocument();
    expect(container.querySelector(".overflow-x-auto table")).not.toBeNull();
    expect(container.querySelector("thead tr")).toHaveClass("text-left");
  });
});
