"use client";

import { useState, useCallback, useRef } from "react";
import { claim } from "@/services/market";
import { useWallet } from "@/hooks/useWallet";
import type { TransactionResult, AppError } from "@/types";

export type TxStage =
  | "idle"
  | "building"
  | "signing"
  | "submitting"
  | "confirmed"
  | "failed";

interface UseClaimResult {
  submit: (marketId: number) => Promise<void>;
  result: TransactionResult | null;
  loading: boolean;
  stage: TxStage;
  error: string | null;
  reset: () => void;
}

export function useClaim(): UseClaimResult {
  const { publicKey, signTransaction } = useWallet();
  const [result, setResult] = useState<TransactionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<TxStage>("idle");
  const [error, setError] = useState<string | null>(null);
  // Claim buttons share this hook per component; the ref guard is synchronous
  // so rapid clicks cannot submit the same claim twice before re-render.
  const inFlightRef = useRef(false);

  const submit = useCallback(
    async (marketId: number) => {
      if (inFlightRef.current) return;
      if (!publicKey) {
        setError("Wallet not connected");
        return;
      }

      inFlightRef.current = true;
      setLoading(true);
      setError(null);
      setResult(null);
      setStage("building");

      try {
        setStage("signing");

        const txResult = await claim(
          publicKey,
          marketId,
          signTransaction
        );

        setStage("submitting");

        if (txResult.success) {
          setStage("confirmed");
          setResult(txResult);
        } else {
          setStage("failed");
          setError(txResult.error || "Claim failed");
          setResult(txResult);
        }
      } catch (err) {
        setStage("failed");
        console.error("[iPredict] useClaim error:", err);
        let message: string;
        if (isAppError(err)) {
          message = err.details && err.details !== err.message
            ? `${err.message} — ${err.details}`
            : err.message;
        } else if (err instanceof Error) {
          message = err.message;
        } else {
          message = String(err) || "Unknown error";
        }
        setError(message);
      } finally {
        inFlightRef.current = false;
        setLoading(false);
      }
    },
    [publicKey, signTransaction]
  );

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
    setStage("idle");
  }, []);

  return { submit, result, loading, stage, error, reset };
}

function isAppError(err: unknown): err is AppError {
  return (
    typeof err === "object" &&
    err !== null &&
    "type" in err &&
    "message" in err
  );
}
