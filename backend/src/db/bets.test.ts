import { describe, it, expect, vi } from 'vitest';
import { getBetsByBettor, BetRow } from './bets';
import { Pool } from 'pg';

describe('getBetsByBettor', () => {
  it('should return bets for a given bettor using a parameterized query', async () => {
    // Mock data based on the BetRow interface
    const mockDate = new Date();
    const mockRows: BetRow[] = [
      {
        market_id: '1',
        bettor: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        net_amount: '100.0000000',
        gross_amount: '102.0000000',
        is_yes: true,
        claimed: false,
        created_at: mockDate,
      },
      {
        market_id: '2',
        bettor: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        net_amount: '50.0000000',
        gross_amount: '51.0000000',
        is_yes: false,
        claimed: true,
        created_at: mockDate,
      }
    ];

    // Create a mock pool with a vi.fn() spy
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: mockRows })
    } as unknown as Pool;

    const bettorAddress = 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const result = await getBetsByBettor(mockPool, bettorAddress);

    // Verify the query execution
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    
    // Verify the parameterization (no string interpolation)
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE bettor = $1'),
      [bettorAddress]
    );

    // Verify the returned shapes exactly match
    expect(result).toEqual(mockRows);
  });
});
