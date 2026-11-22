export const TZ = 'Asia/Kuwait';

/** Dates in Kuwait time as dd/mm/yyyy hh:mm (24h, Latin digits) so they read the same inside LTR number cells. */
function parts(v: string, o: Intl.DateTimeFormatOptions) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', ...o }).formatToParts(new Date(v)).map((x) => [x.type, x.value]));
  return p as Record<string, string>;
}
export function dt(v: string | null | undefined) {
  if (!v) return '—';
  const p = parts(v, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}
export function time(v: string | null | undefined) {
  if (!v) return '—';
  const p = parts(v, { hour: '2-digit', minute: '2-digit' });
  return `${p.hour}:${p.minute}`;
}
export function day(v: string | null | undefined) {
  if (!v) return '—';
  const p = parts(v, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.day}/${p.month}/${p.year}`;
}

/** Amounts arrive as strings with 3 decimals; shown with the currency code. */
export function money(v: string | number | null | undefined, currency = 'KWD') {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return `${n.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} ${currency}`;
}

export function todayKw(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

export const TASK_STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: 'مسودة', tone: 'muted' },
  ready: { label: 'جاهزة', tone: 'info' },
  assigned: { label: 'مسندة', tone: 'info' },
  accepted: { label: 'مقبولة', tone: 'primary' },
  in_progress: { label: 'قيد التنفيذ', tone: 'warning' },
  completed: { label: 'مكتملة', tone: 'success' },
  reviewed: { label: 'مراجَعة', tone: 'success' },
  invoiced: { label: 'مفوترة', tone: 'muted' },
  failed: { label: 'فاشلة', tone: 'danger' },
  canceled: { label: 'ملغاة', tone: 'muted' },
};
export const ROLE: Record<string, string> = {
  owner: 'مالك', admin: 'مدير', dispatcher: 'موزّع', accountant: 'محاسب', branch_supervisor: 'مشرف فرع', driver: 'سائق', customer: 'عميل', employee: 'موظف',
};
export const PACKS: Record<string, string> = { 'delivery@1': 'توصيل', 'concrete@1': 'خرسانة جاهزة', 'staffing@1': 'توريد سائقين', 'internal@1': 'أسطول داخلي' };
export const packLabel = (p: string) => PACKS[p] ?? p;

/** One readable line from a task's free-form attributes (address, recipient, product). */
export function taskSummary(attrs: Record<string, unknown> | null | undefined): string {
  if (!attrs) return '—';
  const pick = (o: unknown, k: string) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined);
  const parts = [
    attrs.title, attrs.address, pick(attrs.dropoff, 'address'), attrs.recipient_name, pick(attrs.recipient, 'name'), attrs.product,
  ].filter((x): x is string => typeof x === 'string' && x.length > 0);
  return parts.length ? parts.slice(0, 2).join(' · ') : '—';
}

export function ago(v: string | null | undefined): string {
  if (!v) return '—';
  const m = Math.round((Date.now() - new Date(v).getTime()) / 60000);
  if (m < 1) return 'الآن';
  if (m < 60) return `قبل ${m} د`;
  const h = Math.round(m / 60);
  return h < 24 ? `قبل ${h} س` : day(v);
}

const tone = (label: string, t = 'muted') => ({ label, tone: t });
export const ASSET_TYPE: Record<string, string> = {
  car: 'سيارة', motorbike: 'دراجة نارية', van: 'فان', pickup: 'بيك أب', truck: 'شاحنة', mixer: 'خلاطة خرسانة', pump: 'مضخة', trailer: 'مقطورة', bus: 'باص', other: 'أخرى',
};
export const ASSET_STATUS: Record<string, { label: string; tone: string }> = {
  available: tone('متاحة', 'success'), in_use: tone('قيد الاستخدام', 'info'), out_of_service: tone('خارج الخدمة', 'danger'), retired: tone('مستبعدة'),
};
export const WORKER_KIND: Record<string, string> = { driver: 'سائق', courier: 'مندوب توصيل', technician: 'فني', supervisor: 'مشرف', guard: 'حارس' };
export const WORKER_STATUS: Record<string, { label: string; tone: string }> = {
  active: tone('نشط', 'success'), on_leave: tone('في إجازة', 'warning'), suspended: tone('موقوف', 'danger'), left: tone('غادر'),
};
export const DOC_TYPE: Record<string, string> = {
  driving_license: 'رخصة قيادة', vehicle_registration: 'دفتر المركبة', insurance: 'تأمين', civil_id: 'البطاقة المدنية',
  residency: 'إقامة', work_permit: 'إذن عمل', inspection: 'فحص فني', other: 'أخرى',
};

export const CUSTOMER_STATUS: Record<string, { label: string; tone: string }> = {
  active: tone('نشط', 'success'), on_hold: tone('موقوف مؤقتًا', 'warning'), closed: tone('مغلق'),
};
export const CONTRACT_STATUS: Record<string, { label: string; tone: string }> = {
  draft: tone('مسودة'), active: tone('ساري', 'success'), suspended: tone('معلّق', 'warning'), ended: tone('منتهي'),
};
export const UNIT: Record<string, string> = {
  task: 'مهمة', km: 'كيلومتر', hour: 'ساعة', trip: 'رحلة', m3: 'متر مكعب', ton: 'طن', day: 'يوم', month: 'شهر',
};

export const WO_KIND: Record<string, string> = { preventive: 'وقائية', corrective: 'إصلاح', inspection: 'فحص', accident: 'حادث' };
export const WO_STATUS: Record<string, { label: string; tone: string }> = {
  open: tone('مفتوح', 'info'), in_progress: tone('قيد العمل', 'warning'), done: tone('منجز', 'success'), canceled: tone('ملغى'),
};
export const LINE_KIND: Record<string, string> = { part: 'قطعة', labor: 'أجرة عمل', other: 'أخرى' };
export const EXPENSE_CAT: Record<string, string> = {
  fuel: 'وقود', maintenance: 'صيانة', tires: 'إطارات', insurance: 'تأمين', registration: 'تسجيل', fines: 'مخالفات',
  tolls: 'رسوم طرق', parking: 'مواقف', washing: 'غسيل', other: 'أخرى',
};
export const EXPENSE_STATUS: Record<string, { label: string; tone: string }> = {
  submitted: tone('بانتظار الاعتماد', 'warning'), approved: tone('معتمد', 'success'), rejected: tone('مرفوض', 'danger'),
};

export const INVOICE_STATUS: Record<string, { label: string; tone: string }> = {
  draft: tone('مسودة'), issued: tone('صادرة', 'info'), partially_paid: tone('مدفوعة جزئيًا', 'warning'), paid: tone('مدفوعة', 'success'), void: tone('ملغاة', 'danger'),
};
export const PAY_METHOD: Record<string, string> = {
  cash: 'نقدًا', bank_transfer: 'تحويل بنكي', knet: 'كي نت', card: 'بطاقة', cheque: 'شيك', cod_offset: 'خصم من مبالغ التحصيل', other: 'أخرى',
};
export const SKIP_REASON = (r: string) => r === 'no_contract' ? 'بلا عقد' : r === 'invalid_quantities' ? 'كميات غير صالحة' : r.startsWith('unpriced') ? 'وحدة بلا سعر في العقد' : r;

/** Delivery pack (delivery@1) labels. */
export const STAGE: Record<string, string> = {
  at_pickup: 'وصل لنقطة الاستلام', picked_up: 'استلم الشحنة', at_dropoff: 'وصل للمستلم', returned_to_sender: 'أُعيدت للمرسل',
};
export const FAIL_REASON: Record<string, string> = {
  recipient_absent: 'المستلم غير موجود', wrong_address: 'عنوان خاطئ', recipient_refused: 'رفض الاستلام', unreachable: 'تعذّر الاتصال',
  damaged: 'شحنة تالفة', cod_not_paid: 'لم يدفع المبلغ', customer_canceled: 'ألغاه العميل', other: 'سبب آخر',
};
export const POD_METHOD: Record<string, string> = { pin: 'رمز المستلم', photo: 'صورة', signature: 'توقيع' };

export interface KwAddress { area?: string; block?: string; street?: string; avenue?: string; house?: string; floor?: string; apartment?: string; notes?: string; lat?: number; lng?: number; phone?: string; name?: string }
/** "السالمية، ق 5، ش 10، م 12" (same format as the API). */
export function addressLine(a: KwAddress | null | undefined): string {
  if (!a) return '—';
  const parts = [a.area, a.block && `ق ${a.block}`, a.street && `ش ${a.street}`, a.avenue && `ج ${a.avenue}`, a.house && `م ${a.house}`,
    a.floor && `دور ${a.floor}`, a.apartment && `شقة ${a.apartment}`].filter(Boolean);
  return parts.length ? parts.join('، ') : '—';
}

/** Ready-mix concrete pack (concrete@1) labels. */
export const CONCRETE_STAGE: Record<string, string> = { loaded: 'تم التحميل', at_site: 'وصل للموقع', pour_start: 'بدأ الصب', pour_end: 'انتهى الصب' };
Object.assign(STAGE, CONCRETE_STAGE);
export const CONCRETE_FAIL: Record<string, string> = {
  site_not_ready: 'الموقع غير جاهز', age_exceeded: 'تجاوز عمر الخرسانة', rejected_by_site: 'رفضها الموقع', truck_breakdown: 'عطل الخلاطة',
  pump_breakdown: 'عطل المضخة', customer_canceled: 'ألغاه العميل', other: 'سبب آخر',
};
Object.assign(FAIL_REASON, Object.fromEntries(Object.entries(CONCRETE_FAIL).filter(([k]) => !(k in FAIL_REASON))));
export const POUR_STATE: Record<string, { label: string; tone: string }> = {
  scheduled: tone('مجدول', 'info'), in_progress: tone('جارٍ الصب', 'warning'), completed: tone('مكتمل', 'success'), canceled: tone('ملغى'),
};
export const MIXER_STATE: Record<string, { label: string; tone: string }> = {
  loading: tone('تحميل', 'primary'), on_road: tone('في الطريق', 'info'), waiting: tone('انتظار بالموقع', 'warning'), pouring: tone('صب', 'warning'),
  returning: tone('عودة', 'muted'), available: tone('متاحة', 'success'), off: tone('خارج الوردية'),
};
export interface ConcreteSite { name?: string; area?: string; block?: string; street?: string; plot?: string; notes?: string; lat?: number; lng?: number; contact_name?: string; contact_phone?: string }
/** "برج الريم، الشرق، ق 2، قسيمة 15" (same format as the API). */
export function siteLine(s: ConcreteSite | null | undefined): string {
  if (!s) return '—';
  const parts = [s.name, s.area, s.block && `ق ${s.block}`, s.street && `ش ${s.street}`, s.plot && `قسيمة ${s.plot}`].filter(Boolean);
  return parts.length ? parts.join('، ') : '—';
}
export const m3 = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })} م³`);

/** Driver supply pack (staffing@1) labels. */
export const STAFFING_STAGE: Record<string, string> = { check_in: 'سجّل الحضور', check_out: 'سجّل الانصراف' };
Object.assign(STAGE, STAFFING_STAGE);
export const STAFFING_FAIL: Record<string, string> = { sick: 'مرض', vehicle_breakdown: 'عطل المركبة', sent_home_by_customer: 'صرفه العميل', other: 'سبب آخر' };
Object.assign(FAIL_REASON, Object.fromEntries(Object.entries(STAFFING_FAIL).filter(([k]) => !(k in FAIL_REASON))));
export const REQUEST_STATE: Record<string, { label: string; tone: string }> = {
  upcoming: tone('قادم', 'info'), active: tone('ساري', 'success'), ended: tone('منتهٍ'), canceled: tone('ملغى'),
};
export const ELIGIBILITY: Record<string, { label: string; tone: string }> = { ok: tone('مستنداته سليمة', 'success'), warn: tone('مستند ينتهي خلال الفترة', 'warning'), blocked: tone('غير مؤهل', 'danger') };
export const DOC_PROBLEM: Record<string, string> = { missing: 'غير موجود', expired: 'منتهٍ', expires_during: 'ينتهي خلال الفترة' };
export const WORKER_DOC_TYPES = ['driving_license', 'residency', 'civil_id', 'work_permit'];
export const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
export const workDaysLine = (d: number[]) => (d.length === 7 ? 'كل الأيام' : d.join(',') === '0,1,2,3,4' ? 'الأحد – الخميس' : d.map((x) => WEEKDAYS[x]).join('، '));
export const hours = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })} س`);

/** In-house fleet pack (internal@1) labels. */
export const INTERNAL_STAGE: Record<string, string> = { vehicle_out: 'استلم المركبة', vehicle_back: 'أرجع المركبة' };
Object.assign(STAGE, INTERNAL_STAGE);
export const INTERNAL_FAIL: Record<string, string> = { vehicle_breakdown: 'عطل المركبة', accident: 'حادث', trip_canceled: 'أُلغي المشوار', other: 'سبب آخر' };
Object.assign(FAIL_REASON, Object.fromEntries(Object.entries(INTERNAL_FAIL).filter(([k]) => !(k in FAIL_REASON))));
export const VR_STATUS: Record<string, { label: string; tone: string }> = {
  pending: tone('بانتظار الموافقة', 'warning'), approved: tone('موافق عليه', 'info'), rejected: tone('مرفوض', 'danger'), allocated: tone('خُصصت مركبة', 'primary'),
  in_use: tone('المركبة مع الموظف', 'warning'), returned: tone('أُرجعت', 'success'), canceled: tone('ملغى'),
};
export const VEHICLE_STATE: Record<string, { label: string; tone: string }> = {
  free: tone('متاحة', 'success'), booked: tone('محجوزة الآن', 'info'), in_use: tone('في مشوار', 'warning'), out_of_service: tone('خارج الخدمة', 'danger'),
};
/** Fuel gauge in eighths (0–8). */
export const fuelLine = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n === 8 ? 'ممتلئ' : n === 0 ? 'فارغ' : `${n}/8`);
export const km = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${Number(n).toLocaleString('en-US')} كم`);
