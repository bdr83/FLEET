'use client';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) { super(message); }
}

/** Calls the API through this app's /api proxy (session cookies are added on the server). */
export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(`/api/v1${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'x-fp-csrf': '1', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (r.status === 401) {
    if (typeof window !== 'undefined' && !location.pathname.startsWith('/login')) location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    throw new ApiError(401, 'انتهت الجلسة');
  }
  if (r.status === 204) return undefined as T;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, messageOf(r.status, data), data);
  return data as T;
}

export async function session(action: string, body: unknown = {}) {
  const r = await fetch(`/api/session/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-fp-csrf': '1' }, body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, messageOf(r.status, data), data);
  return data;
}

/** Readable Arabic messages for common API errors; the API's own reason is kept for detail. */
function messageOf(status: number, data: { message?: unknown }) {
  const m = Array.isArray(data?.message) ? data.message.join('، ') : typeof data?.message === 'string' ? data.message : '';
  if (status === 403) return 'ليست لديك صلاحية لهذا الإجراء';
  if (status === 404) return 'غير موجود أو خارج نطاقك';
  if (status === 409) return m ? `تعارض: ${m}` : 'تعارض مع حالة حالية، حدّث الصفحة';
  if (status === 429) return 'محاولات كثيرة، انتظر قليلًا';
  if (status >= 500) return 'خطأ في الخادم، حاول مرة أخرى';
  return m || 'تعذّر تنفيذ الطلب';
}
