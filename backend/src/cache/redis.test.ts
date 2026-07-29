import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cache, redisClient } from './redis';

describe('Redis Cache Client', () => {
  beforeEach(() => {
    // Clear the store before each test
    redisClient.flushall();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should set and get typed JSON data', async () => {
    interface TestData {
      id: number;
      name: string;
    }
    const data: TestData = { id: 1, name: 'Test' };

    await cache.set('test_key', data);
    const retrieved = await cache.get<TestData>('test_key');

    expect(retrieved).toEqual(data);
  });

  it('should return null for non-existent keys', async () => {
    const retrieved = await cache.get('missing_key');
    expect(retrieved).toBeNull();
  });

  it('should return null when reading invalid JSON', async () => {
    // Manually set an invalid JSON string directly via the client
    await redisClient.set('bad_json', '{ bad json');
    
    const retrieved = await cache.get('bad_json');
    expect(retrieved).toBeNull();
  });

  it('should set data with TTL', async () => {
    const data = { temp: true };
    await cache.set('temp_key', data, 10);
    
    // Check if TTL is roughly 10 seconds
    const ttl = await redisClient.ttl('temp_key');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10);
  });

  it('should delete keys', async () => {
    await cache.set('to_del', { a: 1 });
    await cache.del('to_del');
    
    const retrieved = await cache.get('to_del');
    expect(retrieved).toBeNull();
  });
});
