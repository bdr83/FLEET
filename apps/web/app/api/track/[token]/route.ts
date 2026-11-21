import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/server/session';

/** Public tracking data for the recipient's page: no session, the link token is the key. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return NextResponse.json({ message: 'not found' }, { status: 404 });
  const r = await fetch(`${API_URL}/v1/public/track/${token}`, { cache: 'no-store' });
  return new NextResponse(await r.arrayBuffer(), {
    status: r.status,
    headers: { 'content-type': r.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  });
}
