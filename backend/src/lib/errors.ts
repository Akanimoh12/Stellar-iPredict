import { REQUEST_ID_HEADER } from "./log.js";

export interface FastifyErrorLike extends Error { statusCode?: number; code?: string }
export interface FastifyReplyLike { status(code: number): FastifyReplyLike; header(name: string, value: string): FastifyReplyLike; send(payload: unknown): unknown }
export interface FastifyInstanceLike { setErrorHandler(handler: typeof errorHandler): void }
export interface FastifyRequestLike { method: string; url: string; id?: string }

export class HttpError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message = "Bad request") => new HttpError(400, "BAD_REQUEST", message);
export const unauthorized = (message = "Unauthorized") => new HttpError(401, "UNAUTHORIZED", message);
export const forbidden = (message = "Forbidden") => new HttpError(403, "FORBIDDEN", message);
export const notFound = (message = "Not found") => new HttpError(404, "NOT_FOUND", message);
export const methodNotAllowed = (message = "Method not allowed") => new HttpError(405, "METHOD_NOT_ALLOWED", message);
export const requestTimeout = (message = "Request timeout") => new HttpError(408, "REQUEST_TIMEOUT", message);
export const conflict = (message = "Conflict") => new HttpError(409, "CONFLICT", message);
export const payloadTooLarge = (message = "Payload too large") => new HttpError(413, "PAYLOAD_TOO_LARGE", message);

export interface ErrorResponse { error: { code: string; message: string; requestId: string } }

const DEPENDENCY_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "08000", "08001", "08003", "08004", "08006", "08007", "57P01"]);
export function isDependencyUnavailable(error: FastifyErrorLike | Error): boolean {
  const code = (error as FastifyErrorLike).code;
  return typeof code === "string" && DEPENDENCY_CODES.has(code.toUpperCase());
}

export function mapError(error: FastifyErrorLike | Error): { statusCode: number; code: string; message: string } {
  if (error instanceof HttpError) return { statusCode: error.statusCode, code: error.code, message: error.message };
  if (isDependencyUnavailable(error)) return { statusCode: 503, code: "SERVICE_UNAVAILABLE", message: "Service temporarily unavailable" };
  const maybeStatus = (error as FastifyErrorLike).statusCode;
  const rawCode = (error as FastifyErrorLike).code;

  if (rawCode === "FST_ERR_CTP_BODY_TOO_LARGE" || maybeStatus === 413) {
    return { statusCode: 413, code: "PAYLOAD_TOO_LARGE", message: error.message || "Payload too large" };
  }
  if (rawCode === "FST_ERR_REQ_TIMEOUT" || maybeStatus === 408) {
    return { statusCode: 408, code: "REQUEST_TIMEOUT", message: error.message || "Request timeout" };
  }

  const statusCode = typeof maybeStatus === "number" && maybeStatus >= 400 && maybeStatus < 500 ? maybeStatus : 500;
  if (statusCode < 500) {
    const code = rawCode === "FST_ERR_VALIDATION" ? "BAD_REQUEST" : (rawCode ?? "BAD_REQUEST");
    return { statusCode, code, message: error.message || "Request failed" };
  }
  return { statusCode: 500, code: "INTERNAL_SERVER_ERROR", message: "Internal server error" };
}


export function errorHandler(error: FastifyErrorLike, request: FastifyRequestLike, reply: FastifyReplyLike): void {
  const mapped = mapError(error);
  const requestId = request.id ?? "unknown";
  if (mapped.statusCode === 503) reply.header("Retry-After", "5");
  reply.header(REQUEST_ID_HEADER, requestId);
  reply.status(mapped.statusCode).send({ error: { code: mapped.code, message: mapped.message, requestId } } satisfies ErrorResponse);
}

export function registerErrorHandler(app: FastifyInstanceLike): void {
  app.setErrorHandler(errorHandler);
}

// ── Unknown routes and methods ────────────────────────────────────────────────

/** The shape of a Fastify `onRoute` payload that we care about. */
export interface RouteDefinition { method: string | string[]; url: string }

/** Strips the query string and any trailing slash so `/x/` and `/x` compare equal. */
export function normalizePath(path: string): string {
  const [withoutQuery = ""] = path.split("?");
  return withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, "") : withoutQuery;
}

const escapeRegExp = (segment: string) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Compiles a Fastify route pattern into a matcher for concrete request paths.
 *
 * Parametric segments collapse to "anything but a slash", which ignores any
 * regex constraint on the param (`:id(\\d+)`). That only ever widens the match,
 * and the cost of being wrong is a 405 where a 404 was marginally more precise.
 */
function compileRoutePattern(url: string): RegExp {
  const source = normalizePath(url)
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) return "[^/]+";
      if (segment === "*") return ".*";
      return escapeRegExp(segment);
    })
    .join("/");

  return new RegExp(`^${source}$`);
}

/** A catch-all matches every path, so it says nothing about which methods a
 * resource supports. @fastify/cors registers one for preflight; counting it
 * would turn every 404 into a 405. */
const isCatchAll = (url: string) => normalizePath(url) === "*" || normalizePath(url) === "/*";

/** The methods registered for each route pattern, used to answer "wrong method?". */
export class RouteTable {
  private readonly routes: { source: string; pattern: RegExp; methods: Set<string> }[] = [];

  add({ method, url }: RouteDefinition): void {
    if (isCatchAll(url)) return;

    const pattern = compileRoutePattern(url);
    let route = this.routes.find((candidate) => candidate.source === pattern.source);
    if (route === undefined) {
      route = { source: pattern.source, pattern, methods: new Set<string>() };
      this.routes.push(route);
    }

    for (const name of Array.isArray(method) ? method : [method]) {
      route.methods.add(name.toUpperCase());
    }
  }

  /** Methods this path accepts, sorted. Empty when no route matches the path at all. */
  allowedMethods(path: string): string[] {
    const normalized = normalizePath(path);
    const methods = new Set<string>();

    for (const route of this.routes) {
      if (!route.pattern.test(normalized)) continue;
      for (const method of route.methods) methods.add(method);
    }

    return [...methods].sort();
  }
}

export interface FastifyRouterLike {
  addHook(name: "onRoute", handler: (route: RouteDefinition) => void): unknown;
  setNotFoundHandler(handler: (request: FastifyRequestLike, reply: FastifyReplyLike) => void): unknown;
}

/**
 * Builds the handler Fastify calls when its router finds nothing.
 *
 * Fastify answers an unmatched method with a bare 404, which reads to a client
 * as "this resource does not exist" when it does. Consulting the route table
 * lets us say 405 with an `Allow` header instead, and either way the body is
 * the same `{ error: { code, message } }` envelope as every other failure.
 */
export function createNotFoundHandler(routes: RouteTable) {
  return function notFoundHandler(request: FastifyRequestLike, reply: FastifyReplyLike): void {
    const path = normalizePath(request.url);
    const allowed = routes.allowedMethods(path);

    if (allowed.length > 0) {
      reply.header("Allow", allowed.join(", "));
      errorHandler(methodNotAllowed(`${request.method} is not allowed on ${path}; allowed: ${allowed.join(", ")}`), request, reply);
      return;
    }

    errorHandler(notFound(`Route ${request.method} ${path} not found`), request, reply);
  };
}

/**
 * Registers the 404/405 handler and starts recording routes.
 *
 * Must be called before any route is added: `onRoute` only fires for routes
 * registered after the hook is in place.
 */
export function registerNotFoundHandler(app: FastifyRouterLike): RouteTable {
  const routes = new RouteTable();

  app.addHook("onRoute", (route) => routes.add(route));
  app.setNotFoundHandler(createNotFoundHandler(routes));

  return routes;
}
