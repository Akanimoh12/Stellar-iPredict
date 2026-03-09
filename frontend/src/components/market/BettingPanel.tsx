"use client";

import React, { useState, useMemo, useEffect } from "react";
import { FiAlertCircle } from "react-icons/fi";
import type { Market, Bet } from "@/types";
import { useWallet } from "@/hooks/useWallet";
import { useBet, type TxStage } from "@/hooks/useBet";
import { useToast } from "@/hooks/useToast";
import { calculatePayout, calculateOdds } from "@/utils/helpers";
import {
  WIN_POINTS,
  LOSE_POINTS,
  WIN_TOKENS,
  LOSE_TOKENS,
  TOTAL_FEE_BPS,
} from "@/config/network";
import TxProgress from "@/components/ui/TxProgress";
import ShareBetButton from "@/components/social/ShareBetButton";

const QUICK_AMOUNTS = [1, 5, 10, 50, 100];

interface BettingPanelProps {
  market: Market;
  userBet: Bet | null;
  balance: number;
  onSuccess?: () => void;
}

function stageTxStep(stage: TxStage): "building" | "signing" | "submitting" | "confirmed" | "failed" {
  if (stage === "idle") return "building";
  return stage;
}

export default function BettingPanel({
  market,
  userBet,
  balance,
  onSuccess,
}: BettingPanelProps) {
  const { publicKey, connected } = useWallet();
  const { submit, result, loading, stage, error, reset } = useBet();
  const { showToast } = useToast();

  const [side, setSide] = useState<boolean>(userBet?.isYes ?? true);
  const [amountStr, setAmountStr] = useState("");
  const [showShare, setShowShare] = useState(false);

  // Lock side if user already has a bet
  useEffect(() => {
    if (userBet) setSide(userBet.isYes);
  }, [userBet]);

  const amount = parseFloat(amountStr) || 0;
  const feeAmount = (amount * TOTAL_FEE_BPS) / 10000;
  const netAmount = amount - feeAmount;

  const isActive =
    !market.resolved &&
    !market.cancelled &&
    market.endTime > Math.floor(Date.now() / 1000);

  const isMinValid = amount >= 1;
  const isBalanceValid = amount <= balance;
  const canSubmit =
    connected && isActive && isMinValid && isBalanceValid && !loading;

  // Calculate potential payout
  const { yesPercent, noPercent } = calculateOdds(
    market.totalYes,
    market.totalNo
  );

  const payout = useMemo(() => {
    const winningSide = side ? market.totalYes + netAmount : market.totalNo + netAmount;
    const totalPool = market.totalYes + market.totalNo + netAmount;
    const existingBet = userBet && userBet.isYes === side ? userBet.amount : 0;
    const userTotal = existingBet + netAmount;
    return calculatePayout(userTotal, winningSide, totalPool);
  }, [side, netAmount, market.totalYes, market.totalNo, userBet]);

  const profit = payout - (userBet?.isYes === side ? userBet.amount : 0) - netAmount;
  const profitPercent =
    netAmount > 0 ? ((profit / netAmount) * 100).toFixed(0) : "0";

  const handleSubmit = async () => {
    if (!canSubmit) return;
    reset();
    await submit(market.id, side, amount);
  };

  // Show share button after confirmed
  const prevStageRef = React.useRef<TxStage>("idle");
  useEffect(() => {
    if (stage === "confirmed" && prevStageRef.current !== "confirmed") {
      setShowShare(true);
      showToast(`Bet of ${amount} XLM on ${side ? "YES" : "NO"} placed!`, "success");
      onSuccess?.();
    } else if (stage === "failed" && prevStageRef.current !== "failed" && error) {
      showToast(error, "error");
    }
    prevStageRef.current = stage;
  }, [stage, error]);

  const handleSetMax = () => {
    setAmountStr(Math.floor(balance).toString());
  };

  const hasExistingBet = userBet !== null;
  const oppositeDisabled = hasExistingBet;

  return (
    <div className="card space-y-5">
      <h3 className="font-heading font-semibold text-lg text-slate-100">
        Place Your Bet
      </h3>

      {/* Existing position */}
      {hasExistingBet && (
        <div className="px-4 py-3 rounded-xl bg-primary-600/10 border border-primary-600/20 text-sm">
          <span className="text-primary-400 font-medium">
            Your position: {userBet.amount.toFixed(2)} XLM on{" "}
            {userBet.isYes ? "YES" : "NO"}
          </span>
        </div>
      )}

      {/* YES / NO toggle */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => !oppositeDisabled || side === true ? setSide(true) : undefined}
          disabled={oppositeDisabled && !side}
          className={`relative py-3 rounded-xl font-semibold text-sm transition-all duration-200 ${
            side === true
              ? "bg-accent-green/20 text-accent-green border-2 border-accent-green shadow-lg shadow-accent-green/10"
              : oppositeDisabled
                ? "bg-surface-hover text-slate-600 border border-surface-border cursor-not-allowed"
                : "bg-surface-card text-slate-400 border border-surface-border hover:border-accent-green/50 hover:text-accent-green"
          }`}
          title={oppositeDisabled && !side ? `You already bet ${userBet!.isYes ? "YES" : "NO"} on this market` : undefined}
        >
          YES ({yesPercent}%)
        </button>
        <button
          onClick={() => !oppositeDisabled || side === false ? setSide(false) : undefined}
          disabled={oppositeDisabled && side}
          className={`relative py-3 rounded-xl font-semibold text-sm transition-all duration-200 ${
            side === false
              ? "bg-accent-red/20 text-accent-red border-2 border-accent-red shadow-lg shadow-accent-red/10"
              : oppositeDisabled
                ? "bg-surface-hover text-slate-600 border border-surface-border cursor-not-allowed"
                : "bg-surface-card text-slate-400 border border-surface-border hover:border-accent-red/50 hover:text-accent-red"
          }`}
          title={oppositeDisabled && side ? `You already bet ${userBet!.isYes ? "YES" : "NO"} on this market` : undefined}
        >
          NO ({noPercent}%)
        </button>
      </div>

      {/* Amount input */}
      <div className="space-y-2">
        <label className="text-xs text-slate-500 font-medium">Amount (XLM)</label>
        <div className="relative">
          <input
            type="number"
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value)}
            placeholder="0.00"
            min="1"
            step="any"
            disabled={!isActive || loading}
            className="w-full px-4 py-3 rounded-xl bg-surface border border-surface-border text-slate-100 text-lg font-medium placeholder-slate-600 focus:outline-none focus:border-primary-600/50 focus:ring-1 focus:ring-primary-600/25 transition-all disabled:opacity-50"
          />
        </div>

        {/* Quick amount buttons */}
        <div className="flex items-center gap-2">
          {QUICK_AMOUNTS.map((qa) => (
            <button
              key={qa}
              onClick={() => setAmountStr(qa.toString())}
              disabled={!isActive || loading}
              className="flex-1 py-1.5 rounded-lg text-xs font-medium bg-surface-card border border-surface-border text-slate-400 hover:text-white hover:border-primary-600/50 transition-colors disabled:opacity-50"
            >
              {qa}
            </button>
          ))}
          <button
            onClick={handleSetMax}
            disabled={!isActive || loading || balance <= 0}
            className="flex-1 py-1.5 rounded-lg text-xs font-medium bg-primary-600/15 border border-primary-600/30 text-primary-400 hover:bg-primary-600/25 transition-colors disabled:opacity-50"
          >
            MAX
          </button>
        </div>

        {/* Wallet balance */}
        <p className="text-xs text-slate-600">
          Balance: {balance.toFixed(2)} XLM
        </p>
      </div>

      {/* Payout calculator */}
      {amount > 0 && (
        <div className="space-y-2 px-4 py-3 rounded-xl bg-surface/60 border border-surface-border">
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-500">Fee ({TOTAL_FEE_BPS / 100}%)</span>
            <span className="text-slate-400">{feeAmount.toFixed(2)} XLM</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-500">If you win</span>
            <span className="text-accent-green font-medium">
              {payout.toFixed(2)} XLM (+{profitPercent}%)
            </span>
          </div>
          <div className="border-t border-surface-border my-1" />
          <div className="text-xs text-slate-500">
            Win: {WIN_POINTS} pts + {WIN_TOKENS} IPRED &nbsp;|&nbsp; Lose: {LOSE_POINTS} pts + {LOSE_TOKENS} IPRED
          </div>
        </div>
      )}

      {/* Validation messages */}
      {amountStr && !isMinValid && (
        <div className="flex items-center gap-2 text-xs text-accent-red">
          <FiAlertCircle className="w-3.5 h-3.5 shrink-0" />
          Minimum bet is 1 XLM
        </div>
      )}
      {amountStr && isMinValid && !isBalanceValid && (
        <div className="flex items-center gap-2 text-xs text-accent-red">
          <FiAlertCircle className="w-3.5 h-3.5 shrink-0" />
          Insufficient balance
        </div>
      )}

      {/* Tx progress */}
      {stage !== "idle" && stage !== "confirmed" && (
        <TxProgress step={stageTxStep(stage)} />
      )}

      {/* Error message */}
      {error && (
        <div className="px-4 py-2.5 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Submit button */}
      {!showShare ? (
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="w-full btn-primary py-3 text-base disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {!connected
            ? "Connect Wallet"
            : !isActive
              ? "Market Closed"
              : loading
                ? "Processing..."
                : hasExistingBet
                  ? "Increase Position"
                  : "Place Bet"}
        </button>
      ) : (
        <div className="space-y-3">
          <div className="text-center text-sm text-accent-green font-medium">
            Bet placed successfully!
          </div>
          <ShareBetButton
            question={market.question}
            amount={amount}
            side={side ? "YES" : "NO"}
            marketId={market.id}
            referralAddress={publicKey || undefined}
          />
          <button
            onClick={() => {
              setShowShare(false);
              setAmountStr("");
              reset();
            }}
            className="w-full btn-secondary py-2.5 text-sm"
          >
            Place Another Bet
          </button>
        </div>
      )}
    </div>
  );
}
