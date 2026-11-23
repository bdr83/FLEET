'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError, session } from '@/lib/api';
import { can, hasPack, Me, MeContext } from '@/components/me';
import { ROLE } from '@/lib/format';

const NAV: { sec?: string; href?: string; label?: string; perm?: string; pack?: string }[] = [
  { sec: 'العمليات' },
  { href: '/', label: 'لوحة التوزيع', perm: 'tasks:read' },
  { href: '/tasks', label: 'المهام', perm: 'tasks:read' },
  { href: '/delivery', label: 'مركز التوصيل', perm: 'tasks:read', pack: 'delivery|courier' },
  { href: '/freight', label: 'الشحن والنقل', perm: 'tasks:read', pack: 'freight' },
  { href: '/concrete', label: 'جدول الصب', perm: 'tasks:read', pack: 'concrete' },
  { href: '/staffing', label: 'لوحة الإسناد', perm: 'tasks:read', pack: 'staffing' },
  { href: '/internal', label: 'أسطول الشركة', perm: 'tasks:read', pack: 'internal' },
  { href: '/distribution', label: 'التوزيع اليومي', perm: 'tasks:read', pack: 'distribution|coldchain' },
  { href: '/coldchain', label: 'سلسلة التبريد', perm: 'tasks:read', pack: 'coldchain' },
  { href: '/courier', label: 'البريد السريع', perm: 'tasks:read', pack: 'courier' },
  { href: '/warehouse', label: 'المستودعات', perm: 'tasks:read', pack: 'warehouse' },
  { href: '/ecommerce', label: 'طلبات المتاجر', perm: 'tasks:read', pack: 'ecommerce' },
  { href: '/school', label: 'النقل المدرسي', perm: 'tasks:read', pack: 'school' },
  { href: '/shuttle', label: 'نقل الموظفين', perm: 'tasks:read', pack: 'shuttle' },
  { href: '/equipment', label: 'تأجير المعدات', perm: 'tasks:read', pack: 'equipment' },
  { href: '/rental', label: 'تأجير السيارات', perm: 'tasks:read', pack: 'rental' },
  { href: '/service', label: 'الصيانة الفنية', perm: 'tasks:read', pack: 'service' },
  { href: '/moving', label: 'نقل الأثاث', perm: 'tasks:read', pack: 'moving' },
  { href: '/containers', label: 'الحاويات', perm: 'tasks:read', pack: 'containers' },
  { href: '/tankers', label: 'الصهاريج', perm: 'tasks:read', pack: 'tankers' },
  { href: '/requests', label: 'طلبات المركبات', perm: 'vehicle_requests:own', pack: 'internal' },
  { href: '/map', label: 'الخريطة الحية', perm: 'fleet:read' },
  { sec: 'الأسطول' },
  { href: '/assets', label: 'المركبات', perm: 'fleet:read' },
  { href: '/workers', label: 'السائقون', perm: 'fleet:read' },
  { href: '/documents', label: 'الوثائق', perm: 'fleet:read' },
  { href: '/maintenance', label: 'الصيانة', perm: 'fleet:read' },
  { href: '/expenses', label: 'المصروفات', perm: 'fleet:read' },
  { sec: 'العملاء والمالية' },
  { href: '/customers', label: 'العملاء', perm: 'customers:read' },
  { href: '/contracts', label: 'العقود', perm: 'customers:read' },
  { href: '/invoices', label: 'الفواتير', perm: 'billing:read' },
  { href: '/receivables', label: 'الذمم والتحصيل', perm: 'billing:read' },
  { sec: 'التحليل والإعداد' },
  { href: '/reports', label: 'التقارير', perm: 'reports:read' },
  { href: '/settings', label: 'الإعدادات', perm: 'org:read' },
];

const PORTAL_ME: Me = {
  user_id: '', phone: null, display_name: null, tenant_id: '', tenant_name: null, tenant_status: null, role: 'customer',
  permissions: ['portal:own'], scope: { legal_entity_ids: [], branch_ids: [] }, legal_entities: [],
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const path = usePathname();
  const router = useRouter();
  useEffect(() => {
    api<Me>('/me').then(setMe).catch(async (e) => {
      // /me is for staff. A customer-portal account has only the portal; a driver uses the mobile app.
      if (e instanceof ApiError && e.status === 403) {
        const p = await api<{ name: string }>('/portal/me').catch(() => null);
        if (p) return setMe({ ...PORTAL_ME, display_name: p.name });
        // an employee of a company using its own fleet: only vehicle requests
        const e = await api<{ user: { id: string; display_name: string | null; phone: string | null; role: string; permissions: string[] } }>('/internal/my').catch(() => null);
        if (e) return setMe({ ...PORTAL_ME, user_id: e.user.id, display_name: e.user.display_name, phone: e.user.phone, role: e.user.role, permissions: e.user.permissions });
        return setFailed('هذا الحساب مخصص لتطبيق السائق على الجوال.');
      }
      setFailed(e.message);
    });
  }, []);
  useEffect(() => setOpen(false), [path]);
  // Customer-portal users only have the portal
  const portalOnly = me?.role === 'customer';
  const requestsOnly = !!me && !portalOnly && !can(me, 'tasks:read') && can(me, 'vehicle_requests:own');
  const home = portalOnly ? '/portal' : requestsOnly ? '/requests' : null;
  useEffect(() => { if (home && !path.startsWith(home)) router.replace(home); }, [home, path, router]);

  if (failed) return <div className="login"><div className="card"><p>{failed}</p><Link href="/login">تسجيل الدخول</Link></div></div>;
  if (!me || (home && !path.startsWith(home))) return <div className="login muted">جارٍ التحميل…</div>;

  // links the user may open, and only the section headings that still have links under them
  const nav = NAV.filter((n) => n.sec || ((!n.perm || can(me, n.perm)) && (!n.pack || hasPack(me, n.pack)))).filter((n, i, all) => !n.sec || (all[i + 1] && !all[i + 1].sec));
  const isOn = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));
  return (
    <MeContext.Provider value={me}>
      <div className="shell">
        <aside className={`side ${open ? 'open' : ''}`} aria-label="القائمة">
          <div className="brand">إدارة الأساطيل</div>
          <nav className="nav">
            {portalOnly ? <Link href="/portal" className="on">طلباتي</Link> : nav.map((n, i) => n.sec
              ? <div className="sec" key={i}>{n.sec}</div>
              : <Link key={n.href} href={n.href!} className={isOn(n.href!) ? 'on' : ''}>{n.label}</Link>)}
          </nav>
        </aside>
        <div className="main">
          <header className="top">
            <div className="row">
              <button className="menu-btn small" onClick={() => setOpen(!open)} aria-label="القائمة">☰</button>
              <strong>{me.tenant_name}</strong>
              {me.tenant_status === 'trial' && <span className="badge t-warning">تجريبي</span>}
            </div>
            <div className="row">
              <span className="muted">{me.display_name ?? <span className="num">{me.email ?? me.phone}</span>} · {ROLE[me.role] ?? me.role}</span>
              <button className="small" onClick={async () => { await session('logout'); location.href = '/login'; }}>خروج</button>
            </div>
          </header>
          <main>{children}</main>
        </div>
      </div>
    </MeContext.Provider>
  );
}
