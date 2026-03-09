"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useWallet } from "@/hooks/useWallet";
import { getAccumulatedFees, getMarkets, withdrawFees } from "@/services/market";
import { FiDollarSign, FiBarChart2, FiDownload, FiActivity } from "react-icons/fi";
import Spinner from "@/components/ui/Spinner";
import type { TxStage } from "@/hooks/useClaim";
import TxProgress from "@/components/ui/TxProgress";

interface PlatformData {
  accumulatedFees: number;
  totalMarkets: number;
  activeMarkets: number;
  resolvedMarkets: number;
  totalVolume: number;
}

export default function PlatformStats() {
  const { publicKey, signTransaction } = useWallet();
  const [data, setData] = useState<PlatformData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [withdrawStage, setWithdrawStage] = useState<TxStage>("idle");
  const [withdrawError, setWithdrawError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [fees, markets] = await Promise.all([
        getAccumulatedFees(),
        getMarkets(),
      ]);

      const active = markets.filter((m) => !m.resolved && !m.cancelled);
      const resolved = markets.filter((m) => m.resolved);
      const totalVolume = markets.reduce(
        (sum, m) => sum + m.totalYes + m.totalNo,
        0
      );

      setData({
        accumulatedFees: fees,
        totalMarkets: markets.length,
        activeMarkets: active.length,
        resolvedMarkets: resolved.length,
        totalVolume,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load stats");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleWithdraw = useCallback(async () => {
    if (!publicKey) return;
    setWithdrawStage("signing");
    setWithdrawError(null);
    try {
      const result = await withdrawFees(publicKey, signTransaction);
      if (result.success) {
        setWithdrawStage("confirmed");
        fetchData();
        setTimeout(() => setWithdrawStage("idle"), 3000);
      } else {
        setWithdrawStage("failed");
        setWithdrawError(result.error || "Withdraw failed");
      }
    } catch (err) {
      setWithdrawStage("failed");
      setWithdrawError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [publicKey, signTransaction, fetchData]);

  if (loading) {
    return (
      <div className="card">
        <h3 className="font-heading font-semibold text-lg mb-4">Platform Stats</h3>
        <div className="flex justify-center py-8">
          <Spinner size="lg" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="card">
        <h3 className="font-heading font-semibold text-lg mb-4">Platform Stats</h3>
        <p className="text-sm text-accent-red">{error || "No data available"}</p>
      </div>
    );
  }

  const isWithdrawing =
    withdrawStage !== "idle" && withdrawStage !== "confirmed" && withdrawStage !== "failed";

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-5">
        <h3 className="font-heading font-semibold text-lg flex items-center gap-2">
          <FiBarChart2 className="w-5 h-5 text-primary-400" />
          Platform Stats
        </h3>
        <button
          onClick={fetchData}
          className="text-xs text-primary-400 hover:text-primary-300 transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard
          icon={FiActivity}
          label="Active Markets"
          value={data.activeMarkets.toString()}
          color="text-accent-green"
        />
        <StatCard
          icon={FiBarChart2}
          label="Total Markets"
          value={data.totalMarkets.toString()}
          color="text-primary-400"
        />
        <StatCard
          icon={FiDollarSign}
          label="Total Volume"
          value={`${(data.totalVolume / 1e7).toFixed(1)} XLM`}
          color="text-slate-300"
        />
        <StatCard
          icon={FiDollarSign}
          label="Accumulated Fees"
          value={`${(data.accumulatedFees / 1e7).toFixed(4)} XLM`}
          color="text-amber-400"
        />
      </div>

      {/* Withdraw section */}
      <div className="p-4 rounded-xl border border-surface-border bg-surface-hover/20">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-slate-400">Available to Withdraw</p>
            <p className="text-xl font-heading font-bold text-amber-400">
              {(data.accumulatedFees / 1e7).toFixed(4)} XLM
            </p>
          </div>
          <button
            onClick={handleWithdraw}
            disabled={isWithdrawing || data.accumulatedFees === 0 || !publicKey}
            className="btn-primary flex items-center gap-2 disabled:opacity-50"
          >
            {isWithdrawing ? (
              <Spinner size="sm" />
            ) : (
              <FiDownload className="w-4 h-4" />
            )}
            Withdraw
          </button>
        </div>

        {withdrawStage !== "idle" && (
          <div className="mt-3">
            <TxProgress step={withdrawStage} />
          </div>
        )}
        {withdrawError && (
          <p className="text-xs text-accent-red mt-2">{withdrawError}</p>
        )}
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="p-3 rounded-xl bg-surface-hover/30 border border-surface-border/50">
      <div className="flex items-center gap-1.5 mb-1">
        <Icon className={`w-3.5 h-3.5 ${color}`} />
        <span className="text-xs text-slate-500">{label}</span>
      </div>
      <p className={`text-lg font-heading font-bold ${color}`}>{value}</p>
    </div>
  );
}
