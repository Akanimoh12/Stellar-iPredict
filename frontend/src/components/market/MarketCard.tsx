import React from "react";
import Link from "next/link";
import type { Market } from "@/types";
import { calculateOdds } from "@/utils/helpers";
import { FiUsers, FiTrendingUp } from "react-icons/fi";
import MarketImage from "./MarketImage";
import OddsBar from "./OddsBar";
import CountdownTimer from "./CountdownTimer";
import Badge from "@/components/ui/Badge";

interface MarketCardProps {
  market: Market;
}

function getStatusBadge(market: Market) {
  if (market.cancelled) return { variant: "cancelled" as const, label: "Cancelled" };
  if (market.resolved) return { variant: "resolved" as const, label: market.outcome ? "Resolved YES" : "Resolved NO" };
  const now = Math.floor(Date.now() / 1000);
  if (market.endTime > now) return { variant: "active" as const, label: "Active" };
  return { variant: "cancelled" as const, label: "Ended" };
}

export default function MarketCard({ market }: MarketCardProps) {
  const { yesPercent, noPercent } = calculateOdds(market.totalYes, market.totalNo);
  const totalPool = market.totalYes + market.totalNo;
  const status = getStatusBadge(market);

  return (
    <Link
      href={`/markets/${market.id}`}
      className="group block bg-surface-card border border-surface-border rounded-2xl overflow-hidden hover:border-primary-500/50 hover:shadow-lg hover:shadow-primary-500/5 transition-all duration-300 hover:-translate-y-0.5"
    >
      {/* Image with status overlay */}
      <div className="relative">
        <MarketImage
          src={market.imageUrl}
          alt={market.question}
          rounded="top"
        />
        <div className="absolute top-3 left-3">
          <Badge variant={status.variant}>{status.label}</Badge>
        </div>
      </div>

      {/* Content */}
      <div className="p-4 space-y-3">
        {/* Question */}
        <h3 className="font-heading font-semibold text-sm text-slate-100 leading-snug line-clamp-2 group-hover:text-white transition-colors">
          {market.question}
        </h3>

        {/* Odds bar */}
        <OddsBar yesPercent={yesPercent} noPercent={noPercent} />

        {/* Stats row */}
        <div className="flex items-center justify-between text-xs text-slate-500">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <FiTrendingUp className="w-3.5 h-3.5" />
              {totalPool.toFixed(1)} XLM
            </span>
            <span className="inline-flex items-center gap-1">
              <FiUsers className="w-3.5 h-3.5" />
              {market.betCount}
            </span>
          </div>
          <CountdownTimer endTime={market.endTime} />
        </div>
      </div>
    </Link>
  );
}
