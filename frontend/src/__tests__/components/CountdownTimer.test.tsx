import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import React from "react";
import CountdownTimer from "@/components/market/CountdownTimer";

const START_MS = 1_700_000_000_000;
const endIn = (seconds: number) => Math.floor(START_MS / 1000) + seconds;

describe("CountdownTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the remaining time derived from the end time", () => {
    render(<CountdownTimer endTime={endIn(2 * 3600 + 5 * 60)} />);
    expect(screen.getByText("2h 5m")).toBeInTheDocument();
  });

  it("ticks every second in the final hour", () => {
    render(<CountdownTimer endTime={endIn(90)} />);
    expect(screen.getByText("1m 30s")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("1m 29s")).toBeInTheDocument();
  });

  it("recovers the correct time after a throttled background tab", () => {
    // Simulate a tab where the browser suspended timers for 5 minutes. A
    // tick-counting countdown would now be wrong by 5 minutes; a wall-clock
    // countdown must snap to the true remaining time when it next runs.
    render(<CountdownTimer endTime={endIn(2 * 3600)} />);
    vi.setSystemTime(START_MS + 5 * 60 * 1000);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.getByText("1h 55m")).toBeInTheDocument();
  });

  it("shows Ended once the end time has passed", () => {
    render(<CountdownTimer endTime={endIn(10)} />);
    vi.setSystemTime(START_MS + 11_000);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("Ended")).toBeInTheDocument();
  });
});
