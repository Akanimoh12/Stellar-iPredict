import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorType } from "@/types";

const h = vi.hoisted(() => {
  const state = {
    sponsorSecretKey: "",
    server: {
      getAccount: vi.fn(),
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      getTransaction: vi.fn(),
      simulateTransaction: vi.fn(),
      loadAccount: vi.fn(),
    },
    preparedTransaction: {
      fee: "1000",
      toXDR: vi.fn(() => "prepared-xdr"),
    },
    feeBumpTransaction: { sign: vi.fn() },
    contractCall: vi.fn(() => "operation"),
    fromXDR: vi.fn(),
    buildFeeBumpTransaction: vi.fn(),
    Transaction: class {},
    transactionBuilder: undefined as unknown,
  };

  state.transactionBuilder = vi.fn(function () {
    return {
      addOperation: vi.fn().mockReturnThis(),
      setTimeout: vi.fn().mockReturnThis(),
      build: vi.fn(() => state.preparedTransaction),
    };
  });

  return state;
});

vi.mock("@stellar/stellar-sdk", () => ({
  rpc: {
    Server: vi.fn(function () {
      return h.server;
    }),
    Api: {
      GetTransactionStatus: {
        SUCCESS: "SUCCESS",
        FAILED: "FAILED",
        NOT_FOUND: "NOT_FOUND",
      },
      isSimulationError: vi.fn(() => false),
      isSimulationSuccess: vi.fn(() => false),
    },
  },
  Horizon: { Server: vi.fn() },
  TransactionBuilder: Object.assign(h.transactionBuilder, {
    fromXDR: h.fromXDR,
    buildFeeBumpTransaction: h.buildFeeBumpTransaction,
  }),
  Transaction: h.Transaction,
  Contract: class {
    call = h.contractCall;
  },
  Networks: {
    TESTNET: "Test Network",
    PUBLIC: "Public Network",
  },
  Keypair: {
    fromSecret: vi.fn(() => ({ publicKey: () => "GSPONSOR" })),
  },
  xdr: {},
  scValToNative: vi.fn(),
}));

vi.mock("@/config/network", () => ({
  NETWORK: {
    passphrase: "Test Network",
    url: "https://horizon.test",
  },
  ADMIN_PUBLIC_KEY: "GADMIN",
  get SPONSOR_SECRET_KEY() {
    return h.sponsorSecretKey;
  },
  resolveSorobanUrl: () => "https://rpc.test",
}));

vi.mock("@/services/cache", () => ({
  get: vi.fn(() => null),
  set: vi.fn(),
}));

import { buildAndSendTx } from "@/services/soroban";

const PUBLIC_KEY = "GUSER";
const CONTRACT_ID = "CCONTRACT";
const TX_HASH = "a".repeat(64);
const signTransaction = vi.fn();

function callTx() {
  return buildAndSendTx(PUBLIC_KEY, CONTRACT_ID, "place_bet", [], signTransaction);
}

describe("buildAndSendTx", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.sponsorSecretKey = "";
    signTransaction.mockResolvedValue("signed-xdr");
    h.server.getAccount.mockResolvedValue({
      accountId: () => PUBLIC_KEY,
      sequenceNumber: () => "1",
      incrementSequenceNumber: vi.fn(),
    });
    h.server.prepareTransaction.mockResolvedValue(h.preparedTransaction);
    h.server.sendTransaction.mockResolvedValue({ status: "PENDING", hash: TX_HASH });
    h.server.getTransaction.mockResolvedValue({ status: "SUCCESS", hash: TX_HASH });
    h.fromXDR.mockImplementation(() => new h.Transaction());
    h.buildFeeBumpTransaction.mockReturnValue(h.feeBumpTransaction);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns a stable error when simulation fails", async () => {
    h.server.prepareTransaction.mockRejectedValueOnce(new Error("host invocation failed"));

    await expect(callTx()).resolves.toEqual({
      success: false,
      error: "Simulation failed: host invocation failed",
    });
    expect(signTransaction).not.toHaveBeenCalled();
    expect(h.server.sendTransaction).not.toHaveBeenCalled();
  });

  it("returns a stable error when the wallet rejects signing", async () => {
    signTransaction.mockRejectedValueOnce(new Error("User rejected"));

    await expect(callTx()).resolves.toEqual({
      success: false,
      error: "Signing failed: User rejected",
    });
    expect(signTransaction).toHaveBeenCalledWith("prepared-xdr");
    expect(h.server.sendTransaction).not.toHaveBeenCalled();
  });

  it("reports immediate send rejections", async () => {
    h.server.sendTransaction.mockResolvedValueOnce({
      status: "ERROR",
      errorResult: { code: "tx_insufficient_fee" },
    });

    await expect(callTx()).resolves.toEqual({
      success: false,
      error: 'Transaction rejected: Error result: {"code":"tx_insufficient_fee"}',
    });
    expect(h.server.getTransaction).not.toHaveBeenCalled();
  });

  it("reports busy-network responses without polling", async () => {
    h.server.sendTransaction.mockResolvedValueOnce({ status: "TRY_AGAIN_LATER" });

    await expect(callTx()).resolves.toEqual({
      success: false,
      error: "Network busy — please try again in a few seconds",
    });
    expect(h.server.getTransaction).not.toHaveBeenCalled();
  });

  it("wraps the transaction in a capped fee bump when a sponsor is configured", async () => {
    h.sponsorSecretKey = "S_SPONSOR";

    await expect(callTx()).resolves.toEqual({ success: true, hash: TX_HASH });

    expect(h.buildFeeBumpTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: expect.any(Function) }),
      "2000",
      expect.any(h.Transaction),
      "Test Network"
    );
    expect(h.feeBumpTransaction.sign).toHaveBeenCalledTimes(1);
    expect(h.server.sendTransaction).toHaveBeenCalledWith(h.feeBumpTransaction);
    expect(h.server.getTransaction).toHaveBeenCalledWith(TX_HASH);
  });

  it("polls through NOT_FOUND responses until the transaction succeeds", async () => {
    vi.useFakeTimers();
    h.server.getTransaction
      .mockResolvedValueOnce({ status: "NOT_FOUND" })
      .mockResolvedValueOnce({ status: "SUCCESS" });

    const result = callTx();
    await vi.advanceTimersByTimeAsync(2000);

    await expect(result).resolves.toEqual({ success: true, hash: TX_HASH });
    expect(h.server.getTransaction).toHaveBeenCalledTimes(2);
  });

  it("throws a timeout error after the polling budget is exhausted", async () => {
    vi.useFakeTimers();
    h.server.getTransaction.mockResolvedValue({ status: "NOT_FOUND" });

    const result = callTx();
    await vi.advanceTimersByTimeAsync(90_000);

    await expect(result).rejects.toMatchObject({
      type: AppErrorType.TIMEOUT,
      message: "Transaction confirmation timed out",
    });
    expect(h.server.getTransaction).toHaveBeenCalledTimes(45);
  });
});
