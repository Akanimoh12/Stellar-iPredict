import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useVisiblePoll,
  __schedulerGroupCountForTests,
} from "@/hooks/useVisiblePoll";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useVisiblePoll shared scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls at the requested cadence while visible", () => {
    const cb = vi.fn();
    const { unmount } = renderHook(() => useVisiblePoll(cb, 1000));
    act(() => vi.advanceTimersByTime(3000));
    expect(cb).toHaveBeenCalledTimes(3);
    unmount();
  });

  it("shares one timer between hooks with the same interval", () => {
    const a = vi.fn();
    const b = vi.fn();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const first = renderHook(() => useVisiblePoll(a, 5000));
    const second = renderHook(() => useVisiblePoll(b, 5000));
    expect(setIntervalSpy.mock.calls.filter(([, ms]) => ms === 5000)).toHaveLength(1);
    act(() => vi.advanceTimersByTime(5000));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    first.unmount();
    second.unmount();
    setIntervalSpy.mockRestore();
  });

  it("stops all polling when hidden and refreshes once on return", () => {
    const cb = vi.fn();
    const { unmount } = renderHook(() => useVisiblePoll(cb, 1000));
    act(() => vi.advanceTimersByTime(1000));
    expect(cb).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    act(() => vi.advanceTimersByTime(10_000));
    expect(cb).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    expect(cb).toHaveBeenCalledTimes(2); // immediate refresh on return
    act(() => vi.advanceTimersByTime(1000));
    expect(cb).toHaveBeenCalledTimes(3);
    unmount();
  });

  it("does not poll when disabled and releases the group on unmount", () => {
    const cb = vi.fn();
    const { unmount } = renderHook(() => useVisiblePoll(cb, 2000, false));
    act(() => vi.advanceTimersByTime(4000));
    expect(cb).not.toHaveBeenCalled();

    const live = renderHook(() => useVisiblePoll(cb, 2000));
    expect(__schedulerGroupCountForTests()).toBeGreaterThan(0);
    live.unmount();
    unmount();
    expect(__schedulerGroupCountForTests()).toBe(0);
  });
});
