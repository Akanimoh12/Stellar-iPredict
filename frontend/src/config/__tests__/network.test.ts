import { beforeEach, afterAll, describe, it, expect, vi } from "vitest";

describe('Network Config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('USE_BACKEND flag', () => {
    it('should be false by default if NEXT_PUBLIC_USE_BACKEND is not true', async () => {
      delete process.env.NEXT_PUBLIC_USE_BACKEND;
      const { USE_BACKEND } = await import('../network');
      expect(USE_BACKEND).toBe(false);
    });

    it('should be true when NEXT_PUBLIC_USE_BACKEND is "true"', async () => {
      process.env.NEXT_PUBLIC_USE_BACKEND = 'true';
      const { USE_BACKEND } = await import('../network');
      expect(USE_BACKEND).toBe(true);
    });

    it('should be false when NEXT_PUBLIC_USE_BACKEND is "false"', async () => {
      process.env.NEXT_PUBLIC_USE_BACKEND = 'false';
      const { USE_BACKEND } = await import('../network');
      expect(USE_BACKEND).toBe(false);
    });
  });
});
