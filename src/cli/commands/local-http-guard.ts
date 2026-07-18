/**
 * Shared request guard for OpenLore's local HTTP surfaces (the `serve` daemon and
 * the `view` graph server).
 *
 * OpenLore binds more than one local HTTP listener; both must present the same
 * door to a browser. This module is the single, dependency-light home for the
 * security-critical primitives so the two surfaces cannot drift:
 *
 *   - a Host-header allowlist restricted to loopback forms (DNS-rebinding guard),
 *   - an Origin check rejecting foreign browser origins,
 *   - a constant-time token comparison,
 *
 * plus {@link checkLocalHttpRequest}, the composed policy a surface applies per
 * request: reject a cross-origin/rebinding request (403), then require the
 * `x-openlore-token` header when the binding is non-loopback OR the route is a
 * money/agent endpoint (401). See the `mcp-security` spec requirement
 * `AllLocalHttpSurfacesShareTheGuard`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

/** Header a client presents to authenticate to a local OpenLore HTTP surface. */
export const OPENLORE_TOKEN_HEADER = 'x-openlore-token';

/** Hostnames that denote the loopback interface (no DNS resolution involved). */
export const LOOPBACK_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0:0:0:0:0:0:0:1',
  '0000:0000:0000:0000:0000:0000:0000:0001',
]);

/** True if `host` is a loopback literal/name (127.0.0.0/8, ::1, localhost). */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(h)) return true;
  // Any 127.x.y.z address is loopback.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Extract the hostname (sans port, sans brackets) from a Host/Origin authority. */
export function hostnameOf(authority: string): string {
  let a = authority.trim();
  // Strip scheme if this came from an Origin (e.g. http://host:port).
  const scheme = a.indexOf('://');
  if (scheme !== -1) a = a.slice(scheme + 3);
  // Bracketed IPv6: [::1]:port
  if (a.startsWith('[')) {
    const close = a.indexOf(']');
    if (close !== -1) return a.slice(1, close).toLowerCase();
  }
  // host:port → host (IPv4 / name only; bare IPv6 has no port form here)
  const colon = a.indexOf(':');
  if (colon !== -1 && a.indexOf(':') === a.lastIndexOf(':')) a = a.slice(0, colon);
  return a.toLowerCase();
}

/**
 * Constant-time string equality. Returns false for length mismatch, but still
 * runs a same-length compare first so timing does not leak the secret's length.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ab.length !== bb.length) {
    // Compare ab to itself to burn comparable time, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * DNS-rebinding / cross-origin defense for a loopback listener. A browser tricked
 * into resolving an attacker domain to 127.0.0.1 still sends the attacker's name in
 * the `Host` header (and an attacker page sends a cross-site `Origin`). We accept a
 * request only when both the Host and any Origin name the loopback interface or the
 * exact bound host. Returns an error string to reject with, or null to allow.
 */
export function originDefenseError(req: IncomingMessage, boundHost: string): string | null {
  const boundName = hostnameOf(boundHost);
  const allowed = (name: string): boolean => isLoopbackHost(name) || name === boundName;

  const hostHeader = req.headers.host;
  if (hostHeader === undefined || !allowed(hostnameOf(hostHeader))) {
    return `Host header "${hostHeader ?? ''}" is not an allowed loopback name (DNS-rebinding guard)`;
  }
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== 'null' && !allowed(hostnameOf(origin))) {
    return `cross-site Origin "${origin}" is not permitted`;
  }
  return null;
}

/** Per-request guard configuration. */
export interface LocalHttpGuardConfig {
  /** The host the server is bound to (from the surface's --host). */
  boundHost: string;
  /** The instance token, if one is configured. */
  token?: string;
  /**
   * Force the token even on a loopback binding — for money/agent endpoints
   * (e.g. the viewer's chat route) that must not be driven by another local
   * process or a header-less rebinding page. On a non-loopback binding the token
   * is always required regardless of this flag.
   */
  requireToken?: boolean;
  /** Header carrying the token. Defaults to {@link OPENLORE_TOKEN_HEADER}. */
  tokenHeader?: string;
}

/** A rejection to send. `null` from {@link checkLocalHttpRequest} means "allow". */
export interface LocalHttpGuardRejection {
  status: number;
  error: string;
}

/**
 * Apply the shared local-HTTP guard to a request. Returns a rejection to send
 * (403 for a rebinding/cross-origin request, 401 for a missing/invalid token) or
 * `null` to allow the request through.
 *
 * Token policy: a token is required when a token is configured AND either the
 * binding is non-loopback (anyone on the network can reach the port) or the
 * caller marked the route `requireToken` (a money/agent endpoint).
 */
export function checkLocalHttpRequest(
  req: IncomingMessage,
  cfg: LocalHttpGuardConfig,
): LocalHttpGuardRejection | null {
  const originErr = originDefenseError(req, cfg.boundHost);
  if (originErr) return { status: 403, error: originErr };

  const tokenRequired =
    cfg.token !== undefined && (cfg.requireToken === true || !isLoopbackHost(cfg.boundHost));
  if (tokenRequired) {
    const presented = req.headers[cfg.tokenHeader ?? OPENLORE_TOKEN_HEADER];
    if (typeof presented !== 'string' || !constantTimeEqual(presented, cfg.token as string)) {
      return { status: 401, error: `invalid or missing ${cfg.tokenHeader ?? OPENLORE_TOKEN_HEADER}` };
    }
  }
  return null;
}

/** Minimal connect-style middleware signature (a subset of what vite/connect pass). */
export type ConnectMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void;

/**
 * Build a connect/vite middleware that enforces {@link checkLocalHttpRequest} on
 * every request that reaches it. Mount it at the `/api` prefix BEFORE any
 * `/api/*` route so no route can be reached without passing the guard.
 *
 * `requireTokenFor(pathname)` receives the request pathname RELATIVE to the mount
 * point (e.g. `/chat` for a request to `/api/chat`) and returns true for routes
 * that must present the token even on a loopback binding.
 */
export function createApiGuardMiddleware(opts: {
  boundHost: string;
  token?: string;
  requireTokenFor?: (relativePathname: string) => boolean;
  tokenHeader?: string;
}): ConnectMiddleware {
  return (req, res, next) => {
    // Under a connect prefix mount ('/api'), req.url is relative to the mount:
    // a request to /api/chat arrives here as '/chat'.
    const rel = (req.url ?? '/').split('?')[0].replace(/\/+$/, '') || '/';
    const rejection = checkLocalHttpRequest(req, {
      boundHost: opts.boundHost,
      token: opts.token,
      requireToken: opts.requireTokenFor ? opts.requireTokenFor(rel) : false,
      tokenHeader: opts.tokenHeader,
    });
    if (rejection) {
      res.statusCode = rejection.status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: rejection.error }));
      return;
    }
    next();
  };
}
