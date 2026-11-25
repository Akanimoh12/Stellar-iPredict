import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const buildShareText = vi.fn();
const buildTwitterShareUrl = vi.fn();
const buildTelegramShareUrl = vi.fn();
const buildWhatsAppShareUrl = vi.fn();
const getMarketUrl = vi.fn();
const writeText = vi.fn().mockResolvedValue(undefined);
const onClose = vi.fn();

vi.mock("@/utils/share", () => ({
  buildShareText,
  buildTwitterShareUrl,
  buildTelegramShareUrl,
  buildWhatsAppShareUrl,
  getMarketUrl,
}));

import SocialShareModal from "@/components/social/SocialShareModal";

function renderModal() {
  return render(
    <SocialShareModal
      question="Will XLM reach $1?"
      amount={25000000}
      side="YES"
      marketId={42}
      referralAddress="GREFERRAL"
      onClose={onClose}
    />
  );
}

describe("SocialShareModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, { clipboard: { writeText } });
    buildShareText.mockReturnValue("shared bet text");
    getMarketUrl.mockReturnValue("https://ipredict.test/markets/42?ref=GREFERRAL");
    buildTwitterShareUrl.mockReturnValue("https://twitter.test/share");
    buildTelegramShareUrl.mockReturnValue("https://telegram.test/share");
    buildWhatsAppShareUrl.mockReturnValue("https://whatsapp.test/share");
  });

  it("renders share links built from the bet details", () => {
    renderModal();

    expect(screen.getByRole("heading", { name: "Share Your Prediction" })).toBeInTheDocument();
    expect(screen.getByText("Will XLM reach $1?")).toBeInTheDocument();
    expect(screen.getByText("2.50 XLM")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /X \(Twitter\)/ })).toHaveAttribute(
      "href",
      "https://twitter.test/share"
    );
    expect(screen.getByRole("link", { name: /Telegram/ })).toHaveAttribute(
      "href",
      "https://telegram.test/share"
    );
    expect(screen.getByRole("link", { name: /WhatsApp/ })).toHaveAttribute(
      "href",
      "https://whatsapp.test/share"
    );
    expect(buildShareText).toHaveBeenCalledWith(
      "Will XLM reach $1?",
      25000000,
      "YES",
      42,
      "GREFERRAL"
    );
  });

  it("copies the referral market URL", async () => {
    renderModal();

    fireEvent.click(screen.getByRole("button", { name: "Copy Link" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://ipredict.test/markets/42?ref=GREFERRAL"));
    expect(await screen.findByText("Link Copied!")).toBeInTheDocument();
  });

  it("closes on Escape", () => {
    renderModal();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
