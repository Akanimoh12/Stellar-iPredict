import { USE_BACKEND, resolveSorobanUrl, NETWORK } from '../network';

describe('Network Config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('USE_BACKEND flag', () => {
    it('should be false by default if NEXT_PUBLIC_USE_BACKEND is not true', async () => {
      process.env.NEXT_PUBLIC_USE_BACKEND = undefined;
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
