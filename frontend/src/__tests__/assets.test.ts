import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("optimized logo and market assets (#840)", () => {
  const publicDir = path.resolve(__dirname, "../../public");

  it("provides an optimized logo.png under 50KB", () => {
    const logoPngPath = path.join(publicDir, "logo.png");
    expect(fs.existsSync(logoPngPath)).toBe(true);

    const stat = fs.statSync(logoPngPath);
    // Previously ~168KB (171,166 bytes); should now be optimized under 50KB
    expect(stat.size).toBeLessThan(50 * 1024);

    const buf = fs.readFileSync(logoPngPath);
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect(buf.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
  });

  it("provides a scalable logo.svg vector format", () => {
    const logoSvgPath = path.join(publicDir, "logo.svg");
    expect(fs.existsSync(logoSvgPath)).toBe(true);

    const content = fs.readFileSync(logoSvgPath, "utf-8");
    expect(content).toContain("<svg");
    expect(content).toContain("viewBox=");
    expect(content).toContain("iP");
  });

  it("provides an optimized logo.webp format", () => {
    const logoWebpPath = path.join(publicDir, "logo.webp");
    expect(fs.existsSync(logoWebpPath)).toBe(true);

    const stat = fs.statSync(logoWebpPath);
    expect(stat.size).toBeLessThan(50 * 1024);

    const buf = fs.readFileSync(logoWebpPath);
    // RIFF....WEBP signature
    expect(buf.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(buf.subarray(8, 12).toString("ascii")).toBe("WEBP");
  });

  it("provides valid default market art in svg, png, and webp formats", () => {
    const marketDir = path.join(publicDir, "images/markets");

    const svgPath = path.join(marketDir, "default-market.svg");
    expect(fs.existsSync(svgPath)).toBe(true);
    const svgContent = fs.readFileSync(svgPath, "utf-8");
    expect(svgContent).toContain("<svg");

    const pngPath = path.join(marketDir, "default-market.png");
    expect(fs.existsSync(pngPath)).toBe(true);
    const pngBuf = fs.readFileSync(pngPath);
    // Must be a real PNG, not the 11-byte 'placeholder' string
    expect(pngBuf.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
    expect(pngBuf.length).toBeGreaterThan(100);

    const webpPath = path.join(marketDir, "default-market.webp");
    expect(fs.existsSync(webpPath)).toBe(true);
    const webpBuf = fs.readFileSync(webpPath);
    expect(webpBuf.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(webpBuf.subarray(8, 12).toString("ascii")).toBe("WEBP");
  });
});
