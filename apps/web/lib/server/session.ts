import 'server-only';
import { NextResponse } from 'next/server';

/**
 * Tokens live in httpOnly cookies set by this server, never in browser JavaScript,
 * so an XSS bug cannot steal a session. The browser only talks to /api/*, which forwards to the API.
 */
export const API_URL = process.env.API_URL ?? 'http://localhost:3000';
export const COOKIE = { access: 'fp_at', refresh: 'fp_rt', user: 'fp_ut' } as const;
const secure = process.env.NODE_ENV === 'production';
const ACCESS_MAX_AGE = 14 * 60;          // the API access token lives 15 min; drop the cookie a minute early
const REFRESH_MAX_AGE = 30 * 24 * 3600;  // [تخمين] align with the API refresh session lifetime
const USER_MAX_AGE = 9 * 60;             // the OTP user token lives 10 min

export function setCookie(res: NextResponse, name: string, value: string, maxAge: number) {
  res.cookies.set(name, value, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge });
}
export function clearCookie(res: NextResponse, name: string) {
  res.cookies.set(name, '', { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 0 });
}
export function setSession(res: NextResponse, t: { access_token: string; refresh_token: string }) {
  setCookie(res, COOKIE.access, t.access_token, ACCESS_MAX_AGE);
  setCookie(res, COOKIE.refresh, t.refresh_token, REFRESH_MAX_AGE);
  clearCookie(res, COOKIE.user);
}
export function setUserToken(res: NextResponse, token: string) {
  setCookie(res, COOKIE.user, token, USER_MAX_AGE);
}

export async function callApi(path: string, init: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: 'no-store',
  });
}

/**
 * Refresh tokens rotate on every use and a reused one revokes the whole session (API rule).
 * Two requests that find an expired access token at the same moment would both refresh with the
 * same token, so concurrent refreshes in this process share one call and its result for a short while.
 * [تخمين] with several web instances, put a shared cache (Redis) here or use sticky sessions.
 */
const inflight = new Map<string, { at: number; p: Promise<{ access_token: string; refresh_token: string } | null> }>();
export function refreshOnce(refreshToken: string) {
  const now = Date.now();
  for (const [k, v] of inflight) if (now - v.at > 30_000) inflight.delete(k);
  const hit = inflight.get(refreshToken);
  if (hit) return hit.p;
  const p = callApi('/v1/auth/refresh', { method: 'POST', body: { refresh_token: refreshToken } })
    .then(async (r) => (r.ok ? ((await r.json()) as { access_token: string; refresh_token: string }) : null))
    .catch(() => null);
  inflight.set(refreshToken, { at: now, p });
  return p;
}

/** Non-GET calls must carry this header: a cross-site form cannot set it, which blocks CSRF on cookie auth. */
export function csrfOk(req: Request) {
  return req.method === 'GET' || req.method === 'HEAD' || req.headers.get('x-fp-csrf') === '1';
}
