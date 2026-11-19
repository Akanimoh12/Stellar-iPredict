import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/social/SocialShareModal", () => ({
  default: ({
    question,
    amount,
    side,
    marketId,
    referralAddress,
    onClose,
  }: {
    question: string;
    amount: number;
    side: "YES" | "NO";
    marketId: number;
    referralAddress?: string;
    onClose: () => void;
  }) => (
    <div data-testid="social-share-modal">
      <p>{question}</p>
      <p>{amount}</p>
      <p>{side}</p>
      <p>{marketId}</p>
      <p>{referralAddress}</p>
      <button onClick={onClose}>Close Modal</button>
    </div>
  ),
}));

import ShareBetButton from "@/components/social/ShareBetButton";

describe("ShareBetButton", () => {
  it("opens and closes the share modal with bet details", () => {
    render(
      <ShareBetButton
        question="Will XLM reach $1?"
        amount={25000000}
        side="YES"
        marketId={42}
        referralAddress="GREFERRAL"
      />
    );

    expect(screen.queryByTestId("social-share-modal")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Share your prediction/i }));

    expect(screen.getByTestId("social-share-modal")).toBeInTheDocument();
    expect(screen.getByText("Will XLM reach $1?")).toBeInTheDocument();
    expect(screen.getByText("25000000")).toBeInTheDocument();
    expect(screen.getByText("YES")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("GREFERRAL")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close Modal" }));
    expect(screen.queryByTestId("social-share-modal")).not.toBeInTheDocument();
  });
});
