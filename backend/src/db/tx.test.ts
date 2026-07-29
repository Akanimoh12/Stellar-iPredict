import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withTransaction } from './tx.js';
import { getClient } from './pool.js';
import { type PoolClient } from 'pg';

vi.mock('./pool.js', () => ({
  getClient: vi.fn(),
}));

describe('withTransaction', () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      query: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    vi.mocked(getClient).mockResolvedValue(mockClient as unknown as PoolClient);
  });

  it('should commit the transaction on success', async () => {
    const mockResult = { id: 1 };
    const fn = vi.fn().mockResolvedValue(mockResult);

    const result = await withTransaction(fn);

    expect(getClient).toHaveBeenCalled();
    expect(mockClient.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(fn).toHaveBeenCalledWith(mockClient);
    expect(mockClient.query).toHaveBeenNthCalledWith(2, 'COMMIT');
    expect(mockClient.release).toHaveBeenCalled();
    expect(result).toBe(mockResult);
  });

  it('should rollback the transaction on error', async () => {
    const error = new Error('Test error');
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withTransaction(fn)).rejects.toThrow(error);

    expect(getClient).toHaveBeenCalled();
    expect(mockClient.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(fn).toHaveBeenCalledWith(mockClient);
    expect(mockClient.query).toHaveBeenNthCalledWith(2, 'ROLLBACK');
    expect(mockClient.release).toHaveBeenCalled();
    
    // Ensure COMMIT was not called
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
  });
});
