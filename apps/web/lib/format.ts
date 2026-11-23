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
/** Sector packs a company can turn on, in the order of the sector list. */
export const PACK_INFO: { code: string; sector: number; label: string; hint: string }[] = [
  { code: 'delivery', sector: 1, label: 'توصيل الطلبات والمندوبين', hint: 'طلبات توصيل، تتبع للمستلم، COD، عمولات' },
  { code: 'freight', sector: 2, label: 'الشحن والنقل البري', hint: 'أوامر نقل، شاحنات ومقطورات، ناقلون من الباطن، ربح الرحلة' },
  { code: 'coldchain', sector: 3, label: 'التوزيع الغذائي والتبريد', hint: 'مسارات مبردة ومجمدة، نوافذ تسليم، قراءات حرارة، تالف وصلاحية' },
  { code: 'courier', sector: 4, label: 'البريد والشحن السريع', hint: 'بوليصات ومحطات، مسح الباركود، محاولات التسليم، الإرجاع للمرسل' },
  { code: 'moving', sector: 5, label: 'نقل الأثاث', hint: 'طلبات نقل بمعاينة وقائمة أغراض، عرض سعر وعربون، شاحنة وطاقم ليوم النقل، مطالبات الأضرار والتقييم' },
  { code: 'containers', sector: 6, label: 'الحاويات والموانئ', hint: 'حاويات استيراد وتصدير بين الميناء والساحة والعميل، تأكيد رقم الحاوية، إيصال البوابة، مراقبة الأرضيات والتأخير' },
  { code: 'tankers', sector: 7, label: 'صهاريج المياه والديزل والوقود', hint: 'طلبات توصيل الماء والديزل باللتر، صهاريج ماء ووقود بسعاتها، اللترات المعبأة والمفرّغة، الفاقد، الطلبات الثابتة' },
  { code: 'warehouse', sector: 8, label: 'المستودعات والتخزين', hint: 'مواقع تخزين، استلام وصرف، أقدم صلاحية أولًا، جرد، تخزين للعملاء' },
  { code: 'ecommerce', sector: 9, label: 'شحن التجارة الإلكترونية', hint: 'متاجر ترسل طلباتها بمفتاح API أو ملف، تتبع للمتجر، مرتجعات، كشف COD' },
  { code: 'school', sector: 10, label: 'النقل المدرسي', hint: 'خطوط صباحية وظهرية، طلاب وأولياء أمور، مشرفة، صعود ونزول وتسليم الطفل، بلاغات غياب، تنبيه طالب باقٍ في الحافلة' },
  { code: 'shuttle', sector: 11, label: 'نقل الموظفين', hint: 'خطوط ثابتة بمحطات ومواعيد، رحلات يومية، تسجيل صعود الركاب، تقرير لكل عميل' },
  { code: 'taxi', sector: 12, label: 'التاكسي والليموزين', hint: 'حجوزات فورية ومسبقة ورحلات مطار، فئات سيارات وتعرفة، وصول وركوب ونزول بالكيلومترات، حسابات شركات ونقد السائقين' },
  { code: 'tour', sector: 13, label: 'الحافلات السياحية والتأجير', hint: 'رحلات مجموعات لمكاتب السياحة والمدارس والشركات، حافلة أو أكثر بسائقها طوال الرحلة، برنامج وكشف ركاب لرحلات الحدود، عدّ الركاب والعداد ذهابًا وعودة' },
  { code: 'staffing', sector: 14, label: 'توفير السائقين والمندوبين', hint: 'إسناد سائقين لعملاء، حضور، كشوف ساعات' },
  { code: 'equipment', sector: 16, label: 'تأجير المعدات الثقيلة', hint: 'تأجير بمشغّل أو بدونه، أيام عمل محجوزة، عدّاد الساعات، حد أدنى يومي، اعتماد الساعات' },
  { code: 'rental', sector: 17, label: 'تأجير السيارات', hint: 'حجوزات وعقود إيجار، استلام وإرجاع بالعدّاد والوقود، رسوم الكيلومترات والوقود والأضرار، توصيل للعميل، المخالفات' },
  { code: 'oilgas', sector: 18, label: 'خدمات النفط والغاز', hint: 'خطط رحلات لمواقع الحقول باعتماد مدير الرحلات، وثائق السائق والمركبة الإلزامية لكل موقع (H2S والتصاريح)، فحص المركبة قبل الانطلاق، بلاغات دورية وإنذار التأخير' },
  { code: 'cranes', sector: 19, label: 'الرافعات ورفعات المعدات', hint: 'جدول الحمولة لكل رافعة، خطة رفع بنسبة الاستخدام، اعتماد الرفعات الحرجة، شهادات الفحص والمشغّل والموجّه، حد الرياح عند التنفيذ' },
  { code: 'concrete', sector: 20, label: 'الخرسانة الجاهزة', hint: 'طلبات صب، خلاطات، تذاكر، انتظار' },
  { code: 'internal', sector: 21, label: 'أسطول الشركة الداخلي', hint: 'طلبات مركبات للموظفين، اعتماد، تكلفة الكيلومتر' },
  { code: 'service', sector: 22, label: 'الصيانة الفنية', hint: 'بلاغات صيانة بأولوية وموعد استجابة، زيارات الفنيين، القطع المستخدمة، الصيانة الدورية' },
  { code: 'distribution', sector: 29, label: 'التوزيع اليومي (مصانع، مطاعم، تجزئة)', hint: 'مسارات توزيع، مرتجعات، تسوية نقدية' },
];
/** Task types of the packs a company turned on (all when the list is unknown). */
export const enabledPacks = (packs?: string[]) => Object.entries(PACKS).filter(([k]) => !packs || packs.includes(k.split('@')[0]));
export const PACKS: Record<string, string> = { 'delivery@1': 'توصيل', 'freight@1': 'نقل بري', 'concrete@1': 'خرسانة جاهزة', 'staffing@1': 'توريد سائقين', 'internal@1': 'أسطول داخلي', 'distribution@1': 'توزيع ذاتي' };
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
  car: 'سيارة', motorbike: 'دراجة نارية', van: 'فان', pickup: 'بيك أب', truck: 'شاحنة', mixer: 'خلاطة خرسانة', pump: 'مضخة', trailer: 'مقطورة', bus: 'باص',
  excavator: 'حفارة', loader: 'شيول', crane: 'رافعة (كرين)', forklift: 'رافعة شوكية', bulldozer: 'بلدوزر', roller: 'مدحلة', grader: 'جريدر', tanker: 'صهريج', other: 'أخرى',
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
  residency: 'إقامة', work_permit: 'إذن عمل', inspection: 'فحص فني',
  h2s: 'دورة H2S', defensive_driving: 'القيادة الوقائية', site_pass: 'تصريح دخول الموقع', hazmat: 'نقل المواد الخطرة', medical: 'لياقة طبية', site_sticker: 'ملصق دخول المركبة',
  tpi_certificate: 'شهادة فحص الرافعة (TPI)', crane_operator: 'رخصة مشغّل رافعة', rigger_cert: 'شهادة موجّه الرفع', other: 'أخرى',
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
/** Oilfield documents a site can require (oilgas pack). [تخمين] to align with the operator's list. */
export const OG_WORKER_DOCS = ['h2s', 'defensive_driving', 'site_pass', 'medical', 'driving_license'];
export const OG_ASSET_DOCS = ['site_sticker', 'inspection', 'insurance', 'vehicle_registration'];
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

/** Own-fleet distribution pack (distribution@1) labels. */
export const DIST_STAGE: Record<string, string> = { load_checked: 'راجع الحمولة', route_back: 'عاد للمستودع' };
Object.assign(STAGE, DIST_STAGE);
export const DIST_FAIL: Record<string, string> = { shop_closed: 'المحل مغلق', refused: 'رفض الاستلام', no_cash: 'لا يوجد نقد', no_space: 'لا مكان للتخزين', vehicle_breakdown: 'عطل المركبة', other: 'سبب آخر' };
Object.assign(FAIL_REASON, Object.fromEntries(Object.entries(DIST_FAIL).filter(([k]) => !(k in FAIL_REASON))));
export const ROUTE_STATUS: Record<string, { label: string; tone: string }> = {
  planned: tone('مخطط', 'info'), loaded: tone('محمّل', 'primary'), out: tone('في الطريق', 'warning'), back: tone('عاد: بانتظار التسوية', 'warning'),
  settled: tone('مُسوّى', 'success'), canceled: tone('ملغى'),
};
export const PRODUCT_UNIT: Record<string, string> = { piece: 'حبة', carton: 'كرتون', crate: 'صندوق', kg: 'كغ', liter: 'لتر', bag: 'كيس' };
export const qtyText = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 }));

/** Freight pack (freight@1) labels. at_pickup / at_dropoff share the delivery labels. */
export const FREIGHT_STAGE: Record<string, string> = { at_pickup: 'وصل لنقطة التحميل', loaded: 'تم التحميل', at_dropoff: 'وصل لنقطة التفريغ', unloaded: 'تم التفريغ' };
export const FREIGHT_FAIL: Record<string, string> = {
  truck_breakdown: 'عطل الشاحنة', refused_by_consignee: 'رفض المستلم', weight_mismatch: 'اختلاف الوزن', cargo_damaged: 'حمولة تالفة',
  address_not_found: 'لم يُعثر على العنوان', cargo_not_ready: 'الحمولة غير جاهزة', customer_canceled: 'ألغاه العميل', other: 'سبب آخر',
};
Object.assign(FAIL_REASON, Object.fromEntries(Object.entries(FREIGHT_FAIL).filter(([k]) => !(k in FAIL_REASON))));
Object.assign(STAGE, { loaded: STAGE.loaded ?? 'تم التحميل', unloaded: 'تم التفريغ' });
export const BILL_UNIT: Record<string, string> = { trip: 'بالرحلة', km: 'بالكيلومتر', ton: 'بالطن' };
export const FREIGHT_MODE: Record<string, string> = { ftl: 'شاحنة كاملة', ltl: 'حمولة جزئية' };
export const kg = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 })} كغ`);

/** Cold chain (coldchain pack) labels. */
export const TEMP_CLASS: Record<string, string> = { ambient: 'عادي', chilled: 'مبرد', frozen: 'مجمد' };
Object.assign(DIST_FAIL, { temp_out_of_range: 'الحرارة خارج النطاق', expired: 'منتهي الصلاحية', late_window: 'خارج نافذة التسليم' });

/** Courier and express (courier pack) labels. Due times by service are [تخمين]. */
export const COURIER_SERVICE: Record<string, string> = { express: 'سريع (4 ساعات)', same_day: 'نفس اليوم', next_day: 'اليوم التالي' };
export const SCAN_EVENT: Record<string, string> = { received: 'استلام في المحطة', sorted: 'فرز', dispatched: 'إرسال من المحطة', arrived: 'وصول للمحطة', returned: 'عودة بعد محاولة', rto_out: 'تسليم للمرسل (إرجاع)' };
export const PARCEL_WHERE: Record<string, { label: string; tone: string }> = {
  at_hub: { label: 'في المحطة', tone: 'info' }, in_transit: { label: 'بين المحطات', tone: 'info' }, with_driver: { label: 'مع المندوب', tone: 'warning' },
  delivered: { label: 'سُلّمت', tone: 'success' }, rto_done: { label: 'أُرجعت للمرسل', tone: 'muted' }, canceled: { label: 'ملغاة', tone: 'muted' },
};
export const SCAN_REJECT: Record<string, string> = {
  unknown_awb: 'بوليصة غير معروفة', closed: 'مغلقة (سُلّمت أو أُرجعت)', with_driver: 'مع المندوب الآن', awaiting_return: 'فشلت: امسحها «عودة بعد محاولة» أولًا',
  not_failed: 'لم تفشل محاولة لها', not_rto: 'غير مقرر إرجاعها',
};

/** Warehousing (warehouse pack) labels. */
export const WH_UNIT: Record<string, string> = { piece: 'قطعة', carton: 'كرتون', pallet: 'طبلية', kg: 'كغ', liter: 'لتر', bag: 'كيس' };
export const LOC_KIND: Record<string, string> = { storage: 'تخزين', pick: 'التقاط', dock: 'رصيف', quarantine: 'حجر' };
export const WH_ORDER_STATUS: Record<string, { label: string; tone: string }> = {
  open: { label: 'مفتوح', tone: 'info' }, picked: { label: 'جُمع', tone: 'warning' }, shipped: { label: 'شُحن', tone: 'success' }, canceled: { label: 'ملغى', tone: 'muted' },
};

/** E-commerce fulfilment (ecommerce pack) labels: the status a store sees. */
export const ECOM_STATUS: Record<string, { label: string; tone: string }> = {
  received: { label: 'مستلم', tone: 'muted' }, processing: { label: 'قيد التجهيز', tone: 'info' }, ready_to_ship: { label: 'جاهز للشحن', tone: 'info' },
  confirmed: { label: 'بانتظار السائق', tone: 'info' }, out_for_delivery: { label: 'خرج للتوصيل', tone: 'warning' }, delivered: { label: 'تم التسليم', tone: 'success' },
  failed: { label: 'تعذر التسليم', tone: 'danger' }, returning_to_store: { label: 'راجع للمتجر', tone: 'warning' }, returned_to_store: { label: 'أُرجع للمتجر', tone: 'muted' },
  canceled: { label: 'ملغى', tone: 'muted' },
};
export const ECOM_SOURCE: Record<string, string> = { api: 'API', import: 'ملف', office: 'المكتب' };

/** Staff transport (shuttle pack) labels. */
export const SHUTTLE_DIRECTION: Record<string, string> = { to_work: 'إلى العمل', from_work: 'من العمل' };
export const ISO_WEEKDAYS: [number, string][] = [[7, 'الأحد'], [1, 'الإثنين'], [2, 'الثلاثاء'], [3, 'الأربعاء'], [4, 'الخميس'], [5, 'الجمعة'], [6, 'السبت']];
export const SHUTTLE_SKIP: Record<string, string> = {
  no_vehicle: 'بلا حافلة', no_driver: 'بلا سائق', vehicle_booked: 'الحافلة محجوزة في الوقت نفسه', driver_booked: 'السائق مشغول في الوقت نفسه',
  vehicle_out_of_service: 'الحافلة خارج الخدمة', driver_inactive: 'السائق غير نشط', past: 'موعد الرحلة مضى', not_generated: 'لم تُولَّد رحلته',
};

/** School transport (school pack) labels. */
export const SCHOOL_DIRECTION: Record<string, string> = { to_school: 'إلى المدرسة', from_school: 'إلى البيوت' };
export const SCHOOL_SKIP: Record<string, string> = { ...SHUTTLE_SKIP, attendant_booked: 'المشرفة مشغولة في الوقت نفسه' };
export const SCHOOL_STATE: Record<string, { label: string; tone: string }> = {
  waiting: { label: 'لم يُسجَّل', tone: 'muted' }, on_board: { label: 'في الحافلة', tone: 'info' }, dropped: { label: 'نزل', tone: 'success' },
  absent: { label: 'غائب', tone: 'warning' }, excused: { label: 'بلّغ بالغياب', tone: 'muted' },
};
export const ABSENCE_SCOPE: Record<string, string> = { both: 'الذهاب والعودة', to_school: 'الذهاب فقط', from_school: 'العودة فقط' };
export const REPORTED_BY: Record<string, string> = { guardian: 'ولي الأمر', school: 'المدرسة', office: 'المكتب' };

/** Taxi and limousine (taxi pack) labels. */
export const TX_CLASS: Record<string, string> = { sedan: 'صالون', suv: 'دفع رباعي', van: 'فان', luxury: 'ليموزين فاخرة' };
export const TX_PAYMENT: Record<string, string> = { cash: 'نقدًا', card: 'بطاقة', account: 'على الحساب' };
export const TX_STATE: Record<string, { label: string; tone: string }> = {
  new: { label: 'بلا سيارة', tone: 'warning' }, assigned: { label: 'مسند', tone: 'info' }, on_way: { label: 'في الطريق للراكب', tone: 'info' },
  waiting: { label: 'ينتظر الراكب', tone: 'warning' }, on_trip: { label: 'في المشوار', tone: 'info' }, done: { label: 'انتهى', tone: 'success' },
  failed: { label: 'تعذّر', tone: 'danger' }, canceled: { label: 'ملغى', tone: 'muted' },
};
export const TX_FAIL: Record<string, string> = { passenger_no_show: 'الراكب لم يحضر', passenger_canceled: 'ألغى الراكب', vehicle_breakdown: 'عطل في السيارة', other: 'سبب آخر' };

/** Tourist and charter buses (tour pack) labels. */
export const TR_STATE: Record<string, { label: string; tone: string }> = {
  planned: { label: 'مقاعد ناقصة', tone: 'warning' }, ready: { label: 'جاهزة', tone: 'info' }, under_way: { label: 'في الرحلة', tone: 'info' },
  back: { label: 'عادت', tone: 'success' }, canceled: { label: 'ملغاة', tone: 'muted' },
};
export const TR_BUS: Record<string, { label: string; tone: string }> = {
  assigned: { label: 'محجوزة', tone: 'info' }, accepted: { label: 'قبلها السائق', tone: 'info' }, in_progress: { label: 'في الرحلة', tone: 'info' },
  completed: { label: 'عادت', tone: 'success' }, failed: { label: 'تعذّرت', tone: 'danger' }, canceled: { label: 'أُلغيت', tone: 'muted' },
};
export const TR_FAIL: Record<string, string> = { bus_breakdown: 'عطل في الحافلة', accident: 'حادث', border_refused: 'رُفض العبور', group_canceled: 'ألغت المجموعة', other: 'سبب آخر' };

/** Oil and gas services (oilgas pack) labels. */
export const OG_STATE: Record<string, { label: string; tone: string }> = {
  draft: { label: 'بانتظار الاعتماد', tone: 'warning' }, approved: { label: 'معتمدة بلا مركبة', tone: 'warning' }, assigned: { label: 'مسندة، بانتظار الاعتماد', tone: 'warning' },
  ready: { label: 'جاهزة', tone: 'info' }, en_route: { label: 'في الطريق', tone: 'info' }, arrived: { label: 'وصلت', tone: 'success' }, done: { label: 'انتهت', tone: 'success' },
  failed: { label: 'تعذّرت', tone: 'danger' }, canceled: { label: 'ملغاة', tone: 'muted' },
};
export const OG_PURPOSE: Record<string, string> = { crew: 'نقل طاقم', equipment: 'معدات', materials: 'مواد', water: 'مياه', waste: 'مخلفات', other: 'أخرى' };
export const OG_FAIL: Record<string, string> = { vehicle_breakdown: 'عطل', inspection_failed: 'لم تجتز الفحص', site_closed: 'الموقع مغلق', gate_refused: 'رُفض الدخول', weather: 'الطقس', accident: 'حادث', other: 'سبب آخر' };
export const OG_CHECK: Record<string, string> = { tyres: 'الإطارات', brakes: 'الفرامل', lights: 'الأضواء', seat_belts: 'أحزمة الأمان', fire_extinguisher: 'طفاية الحريق', first_aid: 'الإسعاف', spill_kit: 'عدة الانسكاب', h2s_monitor: 'كاشف H2S' };

/** Cranes and lifting (cranes pack) labels. */
export const CR_STATUS: Record<string, { label: string; tone: string }> = {
  planned: tone('مخططة', 'info'), done: tone('نُفذت', 'success'), aborted: tone('أُوقفت', 'danger'), canceled: tone('ملغاة'),
};
/** Heavy equipment hire (equipment pack) labels. */
export const RATE_UNIT: Record<string, string> = { hour: 'بالساعة', day: 'باليوم', month: 'بالشهر' };
export const HIRE_STATE: Record<string, { label: string; tone: string }> = {
  booked: { label: 'محجوز', tone: 'info' }, on_hire: { label: 'مؤجَّر', tone: 'success' }, ended: { label: 'انتهى', tone: 'muted' }, canceled: { label: 'ملغى', tone: 'muted' },
};
export const HEAVY_TYPES = ['excavator', 'loader', 'crane', 'forklift', 'bulldozer', 'roller', 'grader'];

/** Car rental (rental pack) labels. */
export const RENTAL_UNIT: Record<string, string> = { day: 'يومي', week: 'أسبوعي', month: 'شهري' };
export const RENTAL_STATE: Record<string, { label: string; tone: string }> = {
  reserved: { label: 'محجوز', tone: 'info' }, out: { label: 'مع العميل', tone: 'success' }, overdue: { label: 'متأخر الإرجاع', tone: 'danger' },
  returned: { label: 'أُرجعت', tone: 'muted' }, canceled: { label: 'ملغى', tone: 'muted' },
};
export const FINE_STATUS: Record<string, { label: string; tone: string }> = {
  open: { label: 'مفتوحة', tone: 'warning' }, charged: { label: 'على المستأجر', tone: 'info' }, waived: { label: 'معفاة', tone: 'muted' }, paid_by_us: { label: 'دفعتها الشركة', tone: 'muted' },
};
export const RENTAL_TYPES = ['car', 'van', 'pickup', 'motorbike', 'bus', 'truck'];

/** Technical maintenance (service pack) labels. */
export const SVC_CATEGORY: Record<string, string> = { ac: 'تكييف', electrical: 'كهرباء', plumbing: 'سباكة', appliance: 'أجهزة منزلية', elevator: 'مصاعد', generator: 'مولدات', other: 'أخرى' };
export const SVC_KIND: Record<string, string> = { repair: 'إصلاح', install: 'تركيب', preventive: 'صيانة دورية' };
export const SVC_PRIORITY: Record<string, { label: string; tone: string }> = { urgent: { label: 'عاجل', tone: 'danger' }, normal: { label: 'عادي', tone: 'info' }, low: { label: 'منخفض', tone: 'muted' } };
export const SVC_STATE: Record<string, { label: string; tone: string }> = {
  new: { label: 'بانتظار فني', tone: 'warning' }, scheduled: { label: 'زيارة محجوزة', tone: 'info' }, on_site: { label: 'الفني في الموقع', tone: 'success' },
  follow_up: { label: 'يحتاج زيارة أخرى', tone: 'warning' }, to_close: { label: 'جاهز للإغلاق', tone: 'info' }, closed: { label: 'مغلق', tone: 'muted' }, canceled: { label: 'ملغى', tone: 'muted' },
};
export const SVC_RESULT: Record<string, { label: string; tone: string }> = { fixed: { label: 'تم الإصلاح', tone: 'success' }, follow_up: { label: 'زيارة أخرى', tone: 'warning' }, not_fixed: { label: 'لم يُصلح', tone: 'danger' } };

/** Furniture moving (moving pack) labels. */
export const MV_SIZE: Record<string, string> = { room: 'غرفة', studio: 'استوديو', apt_1: 'شقة غرفة', apt_2: 'شقة غرفتين', apt_3: 'شقة 3 غرف', apt_4: 'شقة 4 غرف+', villa: 'فيلا / بيت', office: 'مكتب' };
export const MV_SERVICE: Record<string, string> = { packing: 'تغليف', assembly: 'فك وتركيب', crating: 'صناديق خشبية', storage: 'تخزين', cleaning: 'تنظيف' };
export const MV_STATE: Record<string, { label: string; tone: string }> = {
  new: { label: 'بانتظار المعاينة والسعر', tone: 'warning' }, quoted: { label: 'بانتظار رد العميل', tone: 'info' }, accepted: { label: 'بانتظار حجز الطاقم', tone: 'warning' },
  booked: { label: 'الطاقم محجوز', tone: 'info' }, moving: { label: 'جاري النقل', tone: 'success' }, delivered: { label: 'وصل، جاهز للإغلاق', tone: 'info' },
  closed: { label: 'مغلق', tone: 'muted' }, canceled: { label: 'ملغى', tone: 'muted' },
};
export const MV_CLAIM: Record<string, { label: string; tone: string }> = { open: { label: 'مفتوحة', tone: 'warning' }, settled: { label: 'سُوّيت', tone: 'success' }, rejected: { label: 'مرفوضة', tone: 'muted' } };

/** Containers and ports (containers pack) labels. */
export const CT_DIRECTION: Record<string, string> = { import: 'استيراد', export: 'تصدير', local: 'نقل داخلي' };
export const CT_TYPE: Record<string, string> = { dry: 'جاف', high_cube: 'عالي', reefer: 'مبرد', open_top: 'مفتوح السقف', flat_rack: 'مسطح', tank: 'صهريج' };
export const CT_PORT: Record<string, string> = { shuwaikh: 'الشويخ', shuaiba: 'الشعيبة', doha: 'الدوحة', other: 'آخر' };
export const CT_LEG: Record<string, string> = { port_to_customer: 'من الميناء للعميل', empty_to_depot: 'إرجاع الفارغة للساحة', empty_to_customer: 'فارغة من الساحة للعميل', full_to_port: 'الممتلئة للميناء', transfer: 'نقل' };
export const CT_STATE: Record<string, { label: string; tone: string }> = {
  waiting: { label: 'بانتظار السحب', tone: 'warning' }, in_transit: { label: 'على الطريق', tone: 'info' }, at_customer: { label: 'عند العميل', tone: 'info' },
  done: { label: 'أُرجعت، جاهزة للإغلاق', tone: 'success' }, closed: { label: 'مغلقة', tone: 'muted' }, canceled: { label: 'ملغاة', tone: 'muted' },
};

/** Tankers (tankers pack) labels. */
export const TK_PRODUCT: Record<string, string> = { water_fresh: 'ماء عذب', water_brackish: 'ماء صليبي', diesel: 'ديزل', kerosene: 'كيروسين' };
export const TK_CLASS: Record<string, string> = { water: 'ماء', fuel: 'وقود' };
export const TK_STATE: Record<string, { label: string; tone: string }> = {
  new: { label: 'بلا صهريج', tone: 'warning' }, assigned: { label: 'مسند', tone: 'info' }, on_way: { label: 'في الطريق', tone: 'info' },
  delivered: { label: 'وُصّل', tone: 'success' }, failed: { label: 'تعذّر، يُعاد إسناده', tone: 'danger' }, canceled: { label: 'ملغى', tone: 'muted' },
};
