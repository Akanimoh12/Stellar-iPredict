# Security Checks — Route Exposure & Authentication Coverage

> **Status:** Specification for Phase 2 implementation  
> **Current State:** No backend exists. Frontend uses direct RPC calls.  
> This document defines checks for when the backend API is implemented.

---

## Purpose

Automated checks to prevent:
1. **Accidentally exposed debug endpoints** — routes intended for development that survive into production
2. **Unauthenticated routes** — endpoints that should require auth but don't

---

## Check 1: Route Allowlist Validation

### Requirement

All served HTTP routes must be explicitly declared in an allowlist. Any unlisted route causes CI to fail.

### Implementation

**Location:** `backend/test/security/route-allowlist.test.ts`

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { getRouteTable } from '../utils/route-inspector';
import { ALLOWED_PUBLIC_ROUTES } from '../../src/security/route-allowlist';

describe('Route Exposure Check', () => {
  let actualRoutes: string[];

  beforeAll(async () => {
    // Extract all registered routes from the server
    actualRoutes = await getRouteTable();
  });

  it('should not expose any unlisted routes', () => {
    const unlisted = actualRoutes.filter(
      route => !ALLOWED_PUBLIC_ROUTES.includes(route)
    );

    expect(unlisted).toHaveLength(0);
    
    if (unlisted.length > 0) {
      throw new Error(
        `Unlisted routes detected:\n${unlisted.join('\n')}\n\n` +
        `Add them to ALLOWED_PUBLIC_ROUTES in route-allowlist.ts ` +
        `or remove them from the server.`
      );
    }
  });

  it('should not have dead allowlist entries', () => {
    const dead = ALLOWED_PUBLIC_ROUTES.filter(
      route => !actualRoutes.includes(route)
    );

    expect(dead).toHaveLength(0);
    
    if (dead.length > 0) {
      throw new Error(
        `Dead allowlist entries (routes listed but not registered):\n` +
        `${dead.join('\n')}\n\n` +
        `Remove them from ALLOWED_PUBLIC_ROUTES.`
      );
    }
  });
});
```

**Route Inspector Utility:**

```typescript
// backend/test/utils/route-inspector.ts
import { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server';

/**
 * Extracts all registered HTTP routes from the Fastify server.
 * Returns array of "METHOD /path" strings.
 */
export async function getRouteTable(): Promise<string[]> {
  const server: FastifyInstance = await buildServer();
  
  const routes: string[] = [];
  
  for (const route of server.printRoutes({ commonPrefix: false })) {
    // Parse Fastify route string: "└── /api/markets (GET)"
    const match = route.match(/([A-Z]+)\s+(\/[^\s]*)/);
    if (match) {
      const [, method, path] = match;
      routes.push(`${method} ${path}`);
    }
  }
  
  await server.close();
  return routes.sort();
}
```

**Allowlist File:**

```typescript
// backend/src/security/route-allowlist.ts

/**
 * PUBLIC ROUTES — Explicitly allowed HTTP endpoints
 * 
 * Adding a route here makes it public. If a route is registered
 * but not listed, CI will fail with a security error.
 * 
 * Format: "METHOD /path"
 * Example: "GET /api/markets"
 */
export const ALLOWED_PUBLIC_ROUTES = [
  // Health & Metadata
  'GET /health',
  'GET /api/stats',
  
  // Market Data (Read-Only)
  'GET /api/markets',
  'GET /api/markets/:id',
  'GET /api/markets/:id/bets',
  
  // Leaderboard (Read-Only)
  'GET /api/leaderboard',
  
  // User Data (Read-Only)
  'GET /api/users/:address/stats',
  'GET /api/users/:address/bets',
  
  // Oracle (Authenticated via Bearer Token in production)
  'POST /api/oracle/submit',
  
  // Frontend RPC Proxy (Optional)
  'POST /api/rpc',
];

/**
 * FORBIDDEN PATTERNS — Patterns that should NEVER be exposed
 * 
 * These are common debug/admin routes that accidentally leak.
 * If any route matches these patterns, CI fails regardless of allowlist.
 */
export const FORBIDDEN_ROUTE_PATTERNS = [
  /^GET \/debug\/.*/,
  /^GET \/admin\/.*/,
  /^POST \/admin\/.*/,
  /^DELETE \/admin\/.*/,
  /^GET \/internal\/.*/,
  /^GET \.\.\/\.\./,  // Path traversal
  /^GET .*\/config$/,
  /^GET .*\/env$/,
  /^GET \/api\/db\/.*/,
  /^POST \/api\/test\/.*/,
];
```

---

## Check 2: Authentication Coverage

### Requirement

All routes that modify state or access sensitive data must require authentication. Any route missing auth middleware causes CI to fail.

### Implementation

**Location:** `backend/test/security/auth-coverage.test.ts`

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { getRouteTable, getRouteMetadata } from '../utils/route-inspector';

describe('Authentication Coverage Check', () => {
  const UNAUTHENTICATED_ALLOWLIST = [
    // Public read-only routes (no auth required)
    'GET /health',
    'GET /api/markets',
    'GET /api/markets/:id',
    'GET /api/markets/:id/bets',
    'GET /api/leaderboard',
    'GET /api/stats',
    'GET /api/users/:address/stats',
    'GET /api/users/:address/bets',
  ];

  let routes: Array<{ path: string; method: string; hasAuth: boolean }>;

  beforeAll(async () => {
    routes = await getRouteMetadata();
  });

  it('should require auth for all state-modifying routes', () => {
    const stateMutatingMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
    
    const unprotected = routes.filter(route =>
      stateMutatingMethods.includes(route.method) &&
      !route.hasAuth &&
      !UNAUTHENTICATED_ALLOWLIST.includes(`${route.method} ${route.path}`)
    );

    expect(unprotected).toHaveLength(0);
    
    if (unprotected.length > 0) {
      throw new Error(
        `Unprotected state-modifying routes detected:\n` +
        `${unprotected.map(r => `${r.method} ${r.path}`).join('\n')}\n\n` +
        `Add authentication middleware or add to UNAUTHENTICATED_ALLOWLIST ` +
        `with explicit justification.`
      );
    }
  });

  it('should require auth for sensitive read routes', () => {
    const sensitivePatterns = [
      /\/api\/admin\/.*/,
      /\/api\/internal\/.*/,
      /\/api\/oracle\/.*/,
    ];

    const unprotected = routes.filter(route =>
      sensitivePatterns.some(pattern => pattern.test(route.path)) &&
      !route.hasAuth
    );

    expect(unprotected).toHaveLength(0);
  });
});
```

**Enhanced Route Inspector:**

```typescript
// backend/test/utils/route-inspector.ts (extended)

interface RouteMetadata {
  method: string;
  path: string;
  hasAuth: boolean;
  middlewares: string[];
}

export async function getRouteMetadata(): Promise<RouteMetadata[]> {
  const server: FastifyInstance = await buildServer();
  const metadata: RouteMetadata[] = [];

  // Fastify stores routes in server[kRoutes]
  const routes = server.printRoutes({ includeHooks: true });

  for (const route of routes) {
    const match = route.match(/([A-Z]+)\s+(\/[^\s]*)/);
    if (!match) continue;

    const [, method, path] = match;
    
    // Check if route has auth middleware
    const routeConfig = server.hasRoute({ method, url: path });
    const hasAuth = routeConfig?.onRequest?.some((hook: any) =>
      hook.name === 'authMiddleware' || hook.name === 'requireAuth'
    ) ?? false;

    metadata.push({ method, path, hasAuth, middlewares: [] });
  }

  await server.close();
  return metadata;
}
```

---

## Check 3: Forbidden Route Patterns

### Requirement

Certain route patterns should **never** be exposed, even if explicitly allowlisted. This catches typos or configuration mistakes.

### Implementation

**Location:** `backend/test/security/forbidden-routes.test.ts`

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { getRouteTable } from '../utils/route-inspector';
import { FORBIDDEN_ROUTE_PATTERNS } from '../../src/security/route-allowlist';

describe('Forbidden Route Pattern Check', () => {
  let actualRoutes: string[];

  beforeAll(async () => {
    actualRoutes = await getRouteTable();
  });

  it('should not expose routes matching forbidden patterns', () => {
    const forbidden = actualRoutes.filter(route =>
      FORBIDDEN_ROUTE_PATTERNS.some(pattern => pattern.test(route))
    );

    expect(forbidden).toHaveLength(0);
    
    if (forbidden.length > 0) {
      throw new Error(
        `CRITICAL SECURITY VIOLATION: Forbidden routes detected:\n` +
        `${forbidden.join('\n')}\n\n` +
        `These routes match FORBIDDEN_ROUTE_PATTERNS and must be removed.`
      );
    }
  });
});
```

---

## Check 4: Environment-Specific Route Check

### Requirement

Some routes should only be available in development/staging, never in production.

### Implementation

**Location:** `backend/test/security/env-routes.test.ts`

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { getRouteTable } from '../utils/route-inspector';

describe('Environment-Specific Route Check', () => {
  const DEV_ONLY_ROUTES = [
    'GET /api/dev/seed-markets',
    'POST /api/dev/reset-db',
    'GET /api/dev/playground',
  ];

  let actualRoutes: string[];

  beforeAll(async () => {
    actualRoutes = await getRouteTable();
  });

  it('should not expose dev-only routes in production', () => {
    if (process.env.NODE_ENV !== 'production') {
      return; // Skip in non-production
    }

    const exposed = actualRoutes.filter(route =>
      DEV_ONLY_ROUTES.includes(route)
    );

    expect(exposed).toHaveLength(0);
    
    if (exposed.length > 0) {
      throw new Error(
        `Dev-only routes detected in production:\n` +
        `${exposed.join('\n')}\n\n` +
        `These routes must be conditionally registered based on NODE_ENV.`
      );
    }
  });
});
```

**Conditional Route Registration:**

```typescript
// backend/src/server.ts
export async function buildServer(): Promise<FastifyInstance> {
  const server = fastify();

  // Always register public routes
  server.register(marketRoutes);
  server.register(leaderboardRoutes);

  // Dev-only routes
  if (process.env.NODE_ENV !== 'production') {
    server.register(devRoutes);
    server.register(playgroundRoutes);
  }

  return server;
}
```

---

## CI Integration

### GitHub Actions Workflow

```yaml
# .github/workflows/security-checks.yml
name: Security Checks

on:
  pull_request:
    paths:
      - 'backend/**'
  push:
    branches: [main]

jobs:
  route-security:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: cd backend && npm ci
      
      - name: Run security checks
        run: cd backend && npm run test:security
        env:
          NODE_ENV: production
      
      - name: Upload security report
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: security-violations
          path: backend/test-results/security-*.json
```

**Package.json script:**

```json
{
  "scripts": {
    "test:security": "vitest run --reporter=verbose test/security/"
  }
}
```

---

## Monitoring in Production

### Runtime Route Logging

Log all requests to detect anomalies:

```typescript
// backend/src/middleware/request-logger.ts
server.addHook('onRequest', async (request, reply) => {
  const route = `${request.method} ${request.url}`;
  
  // Log to monitoring system
  logger.info({
    route,
    ip: request.ip,
    userAgent: request.headers['user-agent'],
    timestamp: Date.now(),
  });
  
  // Alert on suspicious patterns
  if (route.includes('/debug') || route.includes('/admin')) {
    logger.warn({
      alert: 'SUSPICIOUS_ROUTE_ACCESS',
      route,
      ip: request.ip,
    });
  }
});
```

### Metrics to Track

```typescript
// Prometheus metrics
const routeAccessCounter = new Counter({
  name: 'http_route_access_total',
  help: 'Total HTTP requests per route',
  labelNames: ['method', 'path', 'status'],
});

const forbiddenRouteAttempts = new Counter({
  name: 'http_forbidden_route_attempts_total',
  help: 'Attempts to access debug/admin routes',
  labelNames: ['route', 'ip'],
});
```

---

## Shared Mechanism: Route Enumeration

**Reuse for both checks:**

The same `getRouteTable()` utility is used for:
1. **Route allowlist check** (this document)
2. **Authentication coverage check** (this document)

**Benefits:**
- Single source of truth for route introspection
- Tests are fast (no server startup overhead per test)
- Easy to extend with new checks

---

## Example Violations

### Violation 1: Unlisted Route

```
❌ FAIL: Route Exposure Check
Unlisted routes detected:
  GET /api/debug/markets
  POST /api/admin/force-resolve

Add them to ALLOWED_PUBLIC_ROUTES or remove them.
```

### Violation 2: Unprotected State-Modifying Route

```
❌ FAIL: Authentication Coverage Check
Unprotected state-modifying routes detected:
  POST /api/oracle/submit

Add authentication middleware.
```

### Violation 3: Forbidden Pattern

```
❌ FAIL: Forbidden Route Pattern Check
CRITICAL SECURITY VIOLATION: Forbidden routes detected:
  GET /debug/config
  GET /admin/users

These routes match FORBIDDEN_ROUTE_PATTERNS and must be removed.
```

---

## Maintenance

### When to Update Allowlist

**Add routes when:**
- Implementing new public API endpoints
- Adding health checks or monitoring endpoints

**Remove routes when:**
- Deprecating endpoints
- Moving routes behind authentication

### Review Cadence

- **Every PR touching `backend/src/api/`:** Automated check in CI
- **Quarterly:** Manual audit of `ALLOWED_PUBLIC_ROUTES` and `FORBIDDEN_ROUTE_PATTERNS`
- **Before production deploy:** Manual verification of route table in staging

---

## Implementation Status

| Component | Status | Blocking |
|---|---|---|
| Route inspector utility | ❌ Not implemented | Yes |
| Route allowlist test | ❌ Not implemented | Yes |
| Auth coverage test | ❌ Not implemented | Yes |
| Forbidden pattern test | ❌ Not implemented | Yes |
| CI integration | ❌ Not implemented | No |
| Production monitoring | ❌ Not implemented | No |

**Prerequisite:** Backend API implementation (Phase 2)

---

## References

- **Related:** `docs/ORACLE_AND_BACKEND.md` — Backend architecture
- **Related:** `docs/ARCHITECTURE.md` — API endpoint design
- **Industry Standard:** [OWASP API Security Top 10](https://owasp.org/www-project-api-security/)

---

**Last Updated:** 2024-11-23  
**Authors:** Security Team  
**Review Cycle:** Update when backend API is implemented

