import { NextRequest, NextResponse } from 'next/server';
import { API_URL, COOKIE, csrfOk, refreshOnce, setSession } from '@/lib/server/session';

/**
 * Forwards /api/v1/* to the API with the session's access token. If the access token is missing
 * or rejected, refreshes once with the refresh cookie and retries; otherwise answers 401 so the page goes to login.
 */
async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  if (!csrfOk(req)) return NextResponse.json({ message: 'missing csrf header' }, { status: 403 });
  const { path } = await ctx.params;
  if (path.some((p) => p === '..' || p.includes('/'))) return NextResponse.json({ message: 'bad path' }, { status: 400 });
  const target = `${API_URL}/v1/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();

  const send = (token?: string) => fetch(target, {
    method: req.method,
    headers: {
      ...(body ? { 'content-type': req.headers.get('content-type') ?? 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body,
    cache: 'no-store',
  });

  let access = req.cookies.get(COOKIE.access)?.value;
  const refresh = req.cookies.get(COOKIE.refresh)?.value;
  let renewed: { access_token: string; refresh_token: string } | null = null;
  if (!access && refresh) {
    renewed = await refreshOnce(refresh);
    access = renewed?.access_token;
  }
  let r = await send(access);
  if (r.status === 401 && refresh && !renewed) {
    renewed = await refreshOnce(refresh);
    if (renewed) r = await send(renewed.access_token);
  }

  const headers = new Headers();
  for (const h of ['content-type', 'content-disposition']) {
    const v = r.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('cache-control', 'no-store');
  const res = new NextResponse(r.status === 204 ? null : await r.arrayBuffer(), { status: r.status, headers });
  if (renewed) setSession(res, renewed);
  return res;
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
