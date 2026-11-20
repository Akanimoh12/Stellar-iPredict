import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import config from "../../../tailwind.config";

// WCAG 2.1 AA: body text needs a contrast ratio of at least 4.5:1.
const AA_BODY = 4.5;

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const colors = (config.theme?.extend?.colors ?? {}) as Record<string, Record<string, string>>;
const accents = colors.accent;
const surfaces = colors.surface;
const accentTextNames = ["green", "red", "yellow"] as const;
const surfaceNames = ["DEFAULT", "card", "hover"] as const;

describe("accent text colours on the dark theme", () => {
  for (const accent of accentTextNames) {
    for (const surface of surfaceNames) {
      it(`accent ${accent} meets AA on surface ${surface}`, () => {
        const ratio = contrast(accents[accent], surfaces[surface]);
        expect(ratio, `${accent} on ${surface} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_BODY);
      });
    }
  }
});

describe("globals.css mirrors the Tailwind accent tokens", () => {
  const css = readFileSync(resolve(__dirname, "../../app/globals.css"), "utf8");
  for (const accent of accentTextNames) {
    it(`--color-accent-${accent} matches tailwind.config.ts`, () => {
      const match = css.match(new RegExp(`--color-accent-${accent}:\\s*(#[0-9a-fA-F]{6})`));
      expect(match?.[1]?.toLowerCase()).toBe(accents[accent].toLowerCase());
    });
  }
});
