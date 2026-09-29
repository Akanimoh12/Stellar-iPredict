import { describe, it, expect, vi } from 'vitest';
import { getLeaderboard, LeaderboardRow } from './leaderboard';
import { Pool } from 'pg';

describe('getLeaderboard', () => {
  it('should return leaderboard sorted by points with correct parameterization', async () => {
    const mockDate = new Date();
    const mockRows: LeaderboardRow[] = [{ 
      address: 'G1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ', 
      display_name: 'Alice', 
      points: '100', 
      won_bets: 2, 
      lost_bets: 0, 
      updated_at: mockDate 
    }];
    
    const mockPool = { 
      query: vi.fn().mockResolvedValue({ rows: mockRows }) 
    } as unknown as Pool;

    const result = await getLeaderboard(mockPool, { limit: 20, offset: 0, sort: 'points' });

    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY points DESC'),
      [20, 0]
    );
    expect(result).toEqual(mockRows);
  });

  it('should return leaderboard sorted by total bets with correct parameterization', async () => {
    const mockDate = new Date();
    const mockRows: LeaderboardRow[] = [{ 
      address: 'G4567890ABCDEFGHIJKLMNOPQRSTUVWXYZ123', 
      display_name: 'Bob', 
      points: '50', 
      won_bets: 10, 
      lost_bets: 5, 
      updated_at: mockDate 
    }];
    
    const mockPool = { 
      query: vi.fn().mockResolvedValue({ rows: mockRows }) 
    } as unknown as Pool;

    const result = await getLeaderboard(mockPool, { limit: 10, offset: 5, sort: 'bets' });

    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY (won_bets + lost_bets) DESC'),
      [10, 5]
    );
    expect(result).toEqual(mockRows);
  });
});
