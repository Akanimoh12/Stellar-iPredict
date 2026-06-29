import { getGlobalStats } from '../stats';

describe('getGlobalStats', () => {
  it('should return global statistics with correct shape', async () => {
    const stats = await getGlobalStats();
    
    expect(stats).toHaveProperty('totalMarkets');
    expect(stats).toHaveProperty('volume');
    expect(stats).toHaveProperty('totalUsers');
    expect(stats).toHaveProperty('totalBets');
    
    expect(typeof stats.totalMarkets).toBe('number');
    expect(typeof stats.volume).toBe('bigint');
    expect(typeof stats.totalUsers).toBe('number');
    expect(typeof stats.totalBets).toBe('number');
  });
});
