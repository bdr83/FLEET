import { NextRequest, NextResponse } from 'next/server';
import { callApi, clearCookie, COOKIE, csrfOk, setSession, setUserToken } from '@/lib/server/session';

/**
 * Login flow without exposing tokens to the browser:
 * request (send OTP) → verify (user token kept in a cookie, returns the companies) → select or onboard (session cookies) → logout.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ action: string }> }) {
  if (!csrfOk(req)) return NextResponse.json({ message: 'missing csrf header' }, { status: 403 });
  const { action } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const pass = async (r: Response) => NextResponse.json(await r.json().catch(() => ({})), { status: r.status });

  switch (action) {
    case 'request':
      return pass(await callApi('/v1/auth/otp/request', { method: 'POST', body: { phone: body.phone } }));
    case 'verify': {
      const r = await callApi('/v1/auth/otp/verify', { method: 'POST', body: { phone: body.phone, code: body.code } });
      if (!r.ok) return pass(r);
      const data = await r.json();
      const res = NextResponse.json({ memberships: data.memberships });
      setUserToken(res, data.user_token);
      return res;
    }
    case 'select':
    case 'onboard': {
      const ut = req.cookies.get(COOKIE.user)?.value;
      if (!ut) return NextResponse.json({ message: 'login expired' }, { status: 401 });
      const r = action === 'select'
        ? await callApi('/v1/auth/token', { method: 'POST', token: ut, body: { tenant_id: body.tenant_id } })
        : await callApi('/v1/tenants', { method: 'POST', token: ut, body: { name: body.name, country: body.country } });
      if (!r.ok) return pass(r);
      const data = await r.json();
      const res = NextResponse.json({ ok: true });
      setSession(res, data);
      return res;
    }
    case 'logout': {
      const rt = req.cookies.get(COOKIE.refresh)?.value;
      if (rt) await callApi('/v1/auth/logout', { method: 'POST', body: { refresh_token: rt } }).catch(() => undefined);
      const res = NextResponse.json({ ok: true });
      for (const c of Object.values(COOKIE)) clearCookie(res, c);
      return res;
    }
    default:
      return NextResponse.json({ message: 'not found' }, { status: 404 });
  }
}
