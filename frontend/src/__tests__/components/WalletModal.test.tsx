import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const connect = vi.fn();
const onClose = vi.fn();

let walletState = {
  connect,
  connecting: false,
};

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => walletState,
}));

import WalletModal from "@/components/wallet/WalletModal";

describe("WalletModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    walletState = { connect, connecting: false };
  });

  it("connects the selected wallet and closes the modal", async () => {
    connect.mockResolvedValueOnce(undefined);
    render(<WalletModal isOpen onClose={onClose} />);

    expect(screen.getByRole("heading", { name: "Connect Wallet" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Freighter").closest("button")!);

    await waitFor(() => expect(connect).toHaveBeenCalledWith("freighter"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows connection errors", async () => {
    connect.mockRejectedValueOnce(new Error("Wallet unavailable"));
    render(<WalletModal isOpen onClose={onClose} />);

    fireEvent.click(screen.getByText("xBull").closest("button")!);

    expect(await screen.findByText("Wallet unavailable")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
