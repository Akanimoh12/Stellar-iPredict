// =============================================================================
// iPredict — k6 load test for GET /api/markets
// =============================================================================
// Targets the markets list endpoint on the backend API.
//
// Run with:
//   k6 run backend/test/load/markets.js
//
// Environment:
//   TEST_BASE_URL=http://localhost:4000      # base URL of the running backend
//                                            # (default: http://localhost:3000)
//
// Requires a backend and its dependencies (Postgres + Redis) to be running, e.g.
//   cd infra && docker compose -f docker-compose.dev.yml up -d
//   cd backend && npm run dev                # serves the API on :4000
//
// Scenarios:
//   steady — 10 virtual users for 30s (constant load)
//   ramp   — 0 -> 50 -> 0 virtual users over 60s (soak/ramp)
//
// Assertions (thresholds):
//   - 95th percentile response time < 500ms
//   - error rate < 1%
//
// Deterministic: fixed query parameters, no randomisation between runs.
//
// NOTE on the backend rate limiter: the backend enforces a per-IP limit of
// 60 req/min on GET /api/markets (see backend/src/config/rateLimits.ts). Under
// the 50-VU ramp the test legitimately exceeds that budget and will receive
// 429s, which count as errors. Validate the latency/error thresholds against a
// deployment where rate limiting is disabled or fronted by a load balancer
// that spreads the load; otherwise the 1% error threshold will not hold.
// =============================================================================

import http from 'k6/http';
import { check, sleep } from 'k6';

const TEST_BASE_URL = __ENV.TEST_BASE_URL || 'http://localhost:3000';
const MARKETS_PATH = '/api/markets';

// Fixed, deterministic query parameters so every run loads the same traffic
// shape (active markets, newest first, page 1 of 20).
const QUERY = '?filter=active&sort=newest&page=1&limit=20';
const TARGET = `${TEST_BASE_URL}${MARKETS_PATH}${QUERY}`;

export const options = {
  scenarios: {
    // Steady-state scenario: 10 virtual users for 30 seconds.
    steady: {
      executor: 'constant-vus',
      vus: 10,
      duration: '30s',
    },
    // Ramp scenario: 0 -> 50 -> 0 virtual users over 60 seconds.
    ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    // 95th percentile response time below 500ms (both scenarios share the trend)
    http_req_duration: ['p(95)<500'],
    // error rate below 1%
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const res = http.get(TARGET, {
    headers: { Accept: 'application/json' },
    tags: { name: 'markets_list' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'body has markets array': (r) => {
      try {
        const body = r.json();
        return Array.isArray(body.markets);
      } catch (e) {
        return false;
      }
    },
  });

  // Small random-free think time scaled to VU count keeps the request rate
  // from saturating the local server while the scenarios still exercise
  // concurrency. Deterministic: 200ms fixed.
  sleep(0.2);
}
