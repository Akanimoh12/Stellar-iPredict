"use client";

import { useEffect } from "react";
import { FiRefreshCw } from "react-icons/fi";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app-error]", error);
  }, [error]);

  return (
    <div className="card mx-auto my-16 flex max-w-lg flex-col items-center gap-4 p-8 text-center">
      <h2 className="font-heading text-xl font-semibold text-white">
        Something went wrong
      </h2>
      <p className="text-sm text-slate-400">
        The page could not be loaded. Please try again.
      </p>
      <button onClick={reset} className="btn-secondary inline-flex items-center gap-2">
        <FiRefreshCw className="h-4 w-4" />
        Try again
      </button>
    </div>
  );
}
