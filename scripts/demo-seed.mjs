#!/usr/bin/env node
// Demo data for showing the platform to customers: one demo company per sector, owned by one account, each with its
// vehicles, field workers, customers and today's work ready for the office page and the driver app.
//
// Each sector's field worker logs in to the driver app with  driver-<sector>@demo.q8hub.com  and DEMO_PASSWORD.
// Nothing is deleted; running it again adds another set of companies, and a demo driver who then has several companies picks one in the app.
//
//   API_URL=https://api.q8hub.com OWNER_EMAIL=you@example.com OWNER_PASSWORD=... DEMO_PASSWORD=... node scripts/demo-seed.mjs [sector,sector|all]
//   (locally with phone login: API_URL=http://localhost:3000 OWNER_PHONE=+96550000000 DEMO_PASSWORD=... node scripts/demo-seed.mjs)

const API = process.env.API_URL ?? 'http://localhost:3000';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
if (!DEMO_PASSWORD || DEMO_PASSWORD.length < 8) throw new Error('DEMO_PASSWORD (8+ characters) is required: the drivers of the demo companies log in with it');
const stamp = String(Date.now()).slice(-5);

async function call(method, path, body, token) {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(d).slice(0, 300)}`);
  return d;
}
async function ownerToken() {
  if (process.env.OWNER_EMAIL) return (await call('POST', '/v1/auth/login', { email: process.env.OWNER_EMAIL, password: process.env.OWNER_PASSWORD })).user_token;
  const phone = process.env.OWNER_PHONE;
  if (!phone) throw new Error('OWNER_EMAIL and OWNER_PASSWORD (or OWNER_PHONE on a server with OTP_DEV_ECHO) are required');
  const r = await call('POST', '/v1/auth/otp/request', { phone });
  return (await call('POST', '/v1/auth/otp/verify', { phone, code: r.dev_code })).user_token;
}

// Kuwait time helpers
const KW = 3 * 3_600_000;
const kwDay = (plus = 0) => new Date(Date.now() + KW + plus * 86_400_000).toISOString().slice(0, 10);
const hm = (min) => new Date(Date.now() + KW + min * 60_000).toISOString().slice(11, 16);
const inMin = (min) => new Date(Date.now() + min * 60_000).toISOString();
const until = kwDay(300);
const plate = (p, i = 0) => `${p}-${stamp}${i}`;

/** Sector name, the pack codes its company turns on, and what it seeds. `w(kind, name)` adds a worker; the first one gets the demo login. */
const SECTORS = {
  delivery: ['التوصيل', ['delivery'], async ({ T, le, w }) => {
    await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'motorbike', plate_no: plate('DL'), odometer_km: 1200 }, T);
    const d = await w('courier', 'ناصر المطيري');
    const shop = await call('POST', '/v1/customers', { legal_entity_id: le, name: 'متجر العطور' }, T);
    const areas = [['السالمية', 29.335, 48.075], ['حولي', 29.339, 48.028], ['الجابرية', 29.32, 48.03], ['مشرف', 29.29, 48.06]];
    for (const [i, [area, lat, lng]] of areas.entries()) {
      const t = await call('POST', '/v1/tasks', { legal_entity_id: le, customer_id: shop.id, sector_pack: 'delivery@1', ref: `D-${stamp}-${i}`, attributes: {
        dropoff: { area, block: String(i + 2), street: '5', house: String(10 + i), lat, lng }, pickup: { area: 'الشويخ', lat: 29.35, lng: 47.93 },
        recipient: { name: ['أحمد', 'نورة', 'فهد', 'مريم'][i], phone: `5000000${i}` }, cod_amount: i % 2 ? '7.500' : '0' } }, T);
      if (i < 3) await call('POST', `/v1/tasks/${t.id}/assign`, { version: 1, worker_id: d.id }, T);
    }
  }],
  freight: ['النقل البري', ['freight'], async ({ T, le, w }) => {
    const truck = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'truck', plate_no: plate('TR') }, T);
    const trailer = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'trailer', plate_no: plate('TL') }, T);
    const d = await w('driver', 'حمد سائق الشاحنة');
    let s = await call('POST', '/v1/freight/shipments', { legal_entity_id: le, waybill_no: `WB-${stamp}`, cargo: { description: 'أكياس أسمنت', packages: 400, weight_kg: 20000 },
      pickup: { name: 'مصنع الأسمنت', area: 'الشعيبة', lat: 29.03, lng: 48.1 }, dropoff: { name: 'مشروع المطلاع', area: 'المطلاع', lat: 29.6, lng: 47.7 },
      pickup_at: inMin(30), deliver_by: inMin(300), planned_km: 80 }, T);
    s = await call('POST', `/v1/freight/shipments/${s.task_id}/plan`, { version: s.version, trailer_asset_id: trailer.id }, T);
    await call('POST', `/v1/tasks/${s.task_id}/assign`, { version: s.version, worker_id: d.id, asset_id: truck.id, exclusive: true }, T);
  }],
  coldchain: ['النقل المبرد', ['coldchain'], async ({ T, le, w }) => {
    await call('POST', '/v1/distribution/products', { legal_entity_id: le, sku: 'CHK', name: 'دجاج مبرد', unit: 'carton', price: '1.500' }, T);
    const truck = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'truck', plate_no: plate('RF'), odometer_km: 50_000 }, T);
    const d = await w('driver', 'سالم');
    await call('POST', '/v1/distribution/routes', { legal_entity_id: le, route_date: kwDay(), asset_id: truck.id, driver_worker_id: d.id, start_time: '00:00', end_time: '23:59', temp_class: 'chilled',
      stops: [{ name: 'مطعم الشيف', items: [{ sku: 'CHK', qty: 20, expiry: kwDay(5) }] }, { name: 'فندق الخليج', items: [{ sku: 'CHK', qty: 35, expiry: kwDay(5) }] }] }, T);
  }],
  courier: ['البريد السريع', ['courier'], async ({ T, le, w }) => {
    const hub = await call('POST', '/v1/courier/hubs', { legal_entity_id: le, code: 'AHM', name: 'محطة الأحمدي' }, T);
    const d = await w('courier', 'فهد');
    for (const [i, area] of ['الفحيحيل', 'المنقف', 'الصباحية'].entries()) {
      const p = await call('POST', '/v1/courier/parcels', { legal_entity_id: le, awb: `AWB-${stamp}${i}`, service: i ? 'next_day' : 'express', origin_hub_id: hub.id,
        recipient: { name: ['نورة', 'خالد', 'سعاد'][i], phone: `+9655000111${i}` }, dropoff: { area } }, T);
      const t = await call('GET', `/v1/tasks/${p.task_id}`, undefined, T);
      await call('POST', `/v1/tasks/${p.task_id}/assign`, { version: t.version, worker_id: d.id }, T);
    }
  }],
  moving: ['نقل الأثاث', ['moving'], async ({ T, le, w }) => {
    const d = await w('driver', 'سائق النقل');
    const truck = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'truck', plate_no: plate('MV') }, T);
    const cu = await call('POST', '/v1/customers', { legal_entity_id: le, kind: 'individual', name: 'بو فهد' }, T);
    const job = await call('POST', '/v1/moving/jobs', { legal_entity_id: le, customer_id: cu.id, home_size: 'apt_2', services: ['packing'], move_at: inMin(120),
      from_site: { area: 'السالمية', block: '10', floor: '3', phone: '+96550003333' }, to_site: { area: 'الجابرية', block: '4' } }, T);
    await call('POST', `/v1/moving/jobs/${job.id}/survey`, { volume_m3: 30, items: [{ name: 'كنبة', qty: 2 }, { name: 'تلفزيون', fragile: true }] }, T);
    await call('POST', `/v1/moving/jobs/${job.id}/quote`, { quote_amount: '120.000' }, T);
    await call('POST', `/v1/moving/jobs/${job.id}/accept`, {}, T);
    await call('POST', `/v1/moving/jobs/${job.id}/book`, { driver_worker_id: d.id, asset_id: truck.id }, T);
  }],
  containers: ['الحاويات والموانئ', ['containers'], async ({ T, le, w }) => {
    const d = await w('driver', 'سائق التريلا');
    const truck = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'truck', plate_no: plate('CT') }, T);
    const cu = await call('POST', '/v1/customers', { legal_entity_id: le, kind: 'business', name: 'شركة الاستيراد' }, T);
    const job = await call('POST', '/v1/containers/jobs', { legal_entity_id: le, customer_id: cu.id, direction: 'import', container_no: 'MSCU1234566', iso_size: '40', ctype: 'high_cube',
      line: 'MSC', doc_no: 'BL-778', port: 'shuwaikh', site: { name: 'مستودع الري', area: 'الري', phone: '+96550004444' } }, T);
    await call('POST', `/v1/containers/jobs/${job.id}/legs`, { driver_worker_id: d.id, asset_id: truck.id }, T);
  }],
  tankers: ['صهاريج المياه والوقود', ['tankers'], async ({ T, le, w }) => {
    const d = await w('driver', 'سائق التانكر');
    const tk = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'tanker', plate_no: plate('TF') }, T);
    await call('PUT', `/v1/tankers/vehicles/${tk.id}`, { product_class: 'fuel', capacity_l: 20000 }, T);
    const cu = await call('POST', '/v1/customers', { legal_entity_id: le, kind: 'business', name: 'موقع البناء' }, T);
    const job = await call('POST', '/v1/tankers/orders', { legal_entity_id: le, customer_id: cu.id, product: 'diesel', qty_l: 5000, site: { name: 'موقع البناء', area: 'صباح الأحمد', phone: '+96550006666' }, notes: 'المولد خلف البوابة' }, T);
    await call('POST', `/v1/tankers/orders/${job.id}/assign`, { driver_worker_id: d.id, asset_id: tk.id }, T);
  }],
  school: ['النقل المدرسي', ['school'], async ({ T, le, w }) => {
    const bus = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'bus', plate_no: plate('SB') }, T);
    const att = await w('supervisor', 'أم سارة (المشرفة)');
    const drv = await w('driver', 'أبو فهد');
    const route = await call('POST', '/v1/school/routes', { legal_entity_id: le, school_name: 'مدرسة النور', code: 'N7', name: 'النور ← الجابرية', direction: 'from_school', depart_time: hm(60),
      duration_min: 60, days: [1, 2, 3, 4, 5, 6, 7], capacity: 24, asset_id: bus.id, driver_worker_id: drv.id, attendant_worker_id: att.id,
      stops: [{ name: 'مدرسة النور' }, { name: 'الجابرية ق 5', area: 'الجابرية', offset_min: 20 }] }, T);
    await call('POST', `/v1/school/routes/${route.id}/students`, { students: [
      { name: 'سارة', grade: 'KG2', stop_seq: 2, guardian_name: 'أم سارة', guardian_phone: '+96599001111' },
      { name: 'عبدالله', grade: '6', stop_seq: 2, guardian_phone: '+96599002222' },
      { name: 'نورة', grade: '8', stop_seq: 2, guardian_phone: '+96599003333' }] }, T);
    await call('POST', '/v1/school/trips/generate', { date: kwDay(), route_ids: [route.id] }, T);
  }],
  shuttle: ['نقل الموظفين والعمال', ['shuttle'], async ({ T, le, w }) => {
    const bus = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'bus', plate_no: plate('SH') }, T);
    const d = await w('driver', 'راجو');
    const cu = await call('POST', '/v1/customers', { legal_entity_id: le, name: 'شركة المقاولات الوطنية' }, T);
    const route = await call('POST', '/v1/shuttle/routes', { legal_entity_id: le, customer_id: cu.id, code: 'R7', name: 'المصفاة ← المهبولة', direction: 'from_work', depart_time: hm(60),
      duration_min: 60, days: [1, 2, 3, 4, 5, 6, 7], capacity: 30, asset_id: bus.id, driver_worker_id: d.id,
      stops: [{ name: 'مصفاة الأحمدي' }, { name: 'سكن المهبولة', area: 'المهبولة', offset_min: 45 }] }, T);
    await call('POST', `/v1/shuttle/routes/${route.id}/riders`, { riders: [{ name: 'أنيل', staff_no: 'E-1', stop_seq: 2 }, { name: 'جوزيف', staff_no: 'E-2', stop_seq: 2 }, { name: 'رامش', staff_no: 'E-3', stop_seq: 2 }] }, T);
    await call('POST', '/v1/shuttle/trips/generate', { date: kwDay(), route_ids: [route.id] }, T);
  }],
  taxi: ['التاكسي والليموزين', ['taxi'], async ({ T, le, w }) => {
    const car = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'car', plate_no: plate('TX') }, T);
    await call('PUT', `/v1/taxi/cars/${car.id}`, { class: 'sedan' }, T);
    await call('PUT', '/v1/taxi/tariffs', { legal_entity_id: le, class: 'sedan', base: '0.350', per_km: '0.150', per_wait_min: '0.050', min_fare: '1.000' }, T);
    const d = await w('driver', 'سالم');
    const b = await call('POST', '/v1/taxi/bookings', { legal_entity_id: le, passenger_name: 'محمد', passenger_phone: '+96599112233', pickup: { area: 'حولي', block: '3' }, dropoff: { name: 'مستشفى الصباح', area: 'الشويخ' } }, T);
    await call('POST', `/v1/taxi/bookings/${b.id}/assign`, { asset_id: car.id, driver_worker_id: d.id }, T);
  }],
  tour: ['النقل السياحي', ['tour'], async ({ T, le, w }) => {
    const bus = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'bus', plate_no: plate('TB'), capacity: { seats: 50 } }, T);
    const d = await w('driver', 'فهد');
    const cu = await call('POST', '/v1/customers', { legal_entity_id: le, name: 'مدرسة الرواد', kind: 'business' }, T);
    const trip = await call('POST', '/v1/tours/trips', { legal_entity_id: le, customer_id: cu.id, group_name: 'رحلة الصف الخامس', pax: 45, start_at: inMin(60), end_at: inMin(540),
      pickup: 'مدرسة الرواد، الجابرية', destination: 'المدينة الترفيهية', itinerary: [{ place: 'المدينة الترفيهية' }, { place: 'الغداء', note: 'مطعم الشاطئ' }] }, T);
    await call('POST', `/v1/tours/trips/${trip.id}/buses`, { asset_id: bus.id, driver_worker_id: d.id }, T);
  }],
  staffing: ['توريد السائقين', ['staffing'], async ({ T, le, w }) => {
    const cu = await call('POST', '/v1/customers', { legal_entity_id: le, name: 'شركة التموين' }, T);
    const d = await w('driver', 'فهد المطيري');
    for (const doc_type of ['driving_license', 'residency']) await call('POST', '/v1/documents', { doc_type, worker_id: d.id, expires_on: until }, T);
    const req = await call('POST', '/v1/staffing/requests', { legal_entity_id: le, customer_id: cu.id, ref: `SR-${stamp}`, headcount: 2, starts_on: kwDay(), ends_on: kwDay(6),
      shift_start: '07:00', shift_end: '15:00', work_days: [0, 1, 2, 3, 4, 5, 6], site: { name: 'مستودع الري', area: 'الري', lat: 29.3341, lng: 48.0745, contact_name: 'أبو محمد', contact_phone: '50000011' } }, T);
    await call('POST', `/v1/staffing/requests/${req.id}/placements`, { worker_id: d.id }, T);
  }],
  equipment: ['تأجير المعدات الثقيلة', ['equipment'], async ({ T, le, w }) => {
    const crane = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'excavator', plate_no: plate('EX') }, T);
    const d = await w('driver', 'مشغّل الحفارة');
    const cu = await call('POST', '/v1/customers', { legal_entity_id: le, name: 'مقاولات الخليج' }, T);
    await call('POST', '/v1/equipment/hires', { legal_entity_id: le, customer_id: cu.id, asset_id: crane.id, operator_worker_id: d.id, site: { name: 'مشروع جسر الجهراء', area: 'الجهراء' },
      starts_on: kwDay(), ends_on: kwDay(6), shift_start: '00:00', shift_end: '23:59', work_days: [1, 2, 3, 4, 5, 6, 7], min_hours: 8 }, T);
  }],
  rental: ['تأجير السيارات', ['rental'], async ({ T, le, w }) => {
    const car = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'car', plate_no: plate('RC'), make: 'Toyota', model: 'Camry', odometer_km: 20000 }, T);
    await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'car', plate_no: plate('RC', 1), make: 'Nissan', model: 'Patrol', odometer_km: 8000 }, T);
    const d = await w('driver', 'سائق التوصيل');
    const cu = await call('POST', '/v1/customers', { legal_entity_id: le, kind: 'individual', name: 'فهد العتيبي' }, T);
    const ra = await call('POST', '/v1/rental/agreements', { legal_entity_id: le, customer_id: cu.id, asset_id: car.id, pickup_at: inMin(90), return_due: inMin(48 * 60), rate: '12.500',
      drivers: [{ name: 'فهد العتيبي', phone: '+96551112222', licence_no: 'KW-12345', licence_expiry: kwDay(90) }] }, T);
    await call('POST', `/v1/rental/agreements/${ra.id}/moves`, { kind: 'deliver', driver_worker_id: d.id, address: { area: 'السالمية', block: '10', street: '5' } }, T);
  }],
  oilgas: ['خدمات النفط والغاز', ['oilgas'], async ({ T, le, w }) => {
    const van = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'van', plate_no: plate('OG'), capacity: { seats: 14 } }, T);
    const d = await w('driver', 'عبدالله');
    for (const t of ['h2s', 'site_pass']) await call('POST', '/v1/documents', { worker_id: d.id, doc_type: t, expires_on: until }, T);
    await call('POST', '/v1/documents', { asset_id: van.id, doc_type: 'site_sticker', expires_on: until }, T);
    const site = await call('POST', '/v1/oilgas/sites', { legal_entity_id: le, code: 'BRG-GC1', name: 'مركز تجميع 1', field: 'برقان', worker_docs: ['h2s', 'site_pass'], asset_docs: ['site_sticker'], h2s_zone: true, checkin_min: 30 }, T);
    const jm = await call('POST', '/v1/oilgas/journeys', { site_id: site.id, purpose: 'crew', from_place: 'قاعدة الأحمدي', depart_at: inMin(45), eta_at: inMin(135), passengers: 8 }, T);
    await call('POST', `/v1/oilgas/journeys/${jm.id}/assign`, { asset_id: van.id, driver_worker_id: d.id }, T);
    await call('POST', `/v1/oilgas/journeys/${jm.id}/approve`, {}, T);
  }],
  cranes: ['الرافعات والرفع', ['equipment', 'cranes'], async ({ T, le, w }) => {
    const crane = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'crane', plate_no: plate('MC') }, T);
    await call('PUT', `/v1/cranes/fleet/${crane.id}`, { max_capacity_t: 50, wind_limit_ms: 9, chart: [{ radius_m: 3, capacity_t: 50 }, { radius_m: 10, capacity_t: 20 }, { radius_m: 20, capacity_t: 8 }] }, T);
    const op = await w('driver', 'مشغّل الرافعة');
    const rg = await w('technician', 'الموجّه سالم', false);
    await call('POST', '/v1/documents', { asset_id: crane.id, doc_type: 'tpi_certificate', expires_on: until }, T);
    await call('POST', '/v1/documents', { worker_id: op.id, doc_type: 'crane_operator', expires_on: until }, T);
    await call('POST', '/v1/documents', { worker_id: rg.id, doc_type: 'rigger_cert', expires_on: until }, T);
    const cu = await call('POST', '/v1/customers', { legal_entity_id: le, name: 'مقاولات البناء' }, T);
    const hire = await call('POST', '/v1/equipment/hires', { legal_entity_id: le, customer_id: cu.id, asset_id: crane.id, operator_worker_id: op.id, site: { name: 'برج الشرق', area: 'الشرق' },
      starts_on: kwDay(), ends_on: kwDay(2), shift_start: '00:00', shift_end: '23:59', work_days: [1, 2, 3, 4, 5, 6, 7], min_hours: 8 }, T);
    const lift = (o) => call('POST', '/v1/cranes/lifts', { hire_id: hire.id, lift_date: kwDay(), rigger_worker_id: rg.id, ...o }, T);
    const l1 = await lift({ lift_time: '16:00', description: 'رفع مولد', load_t: 16, radius_m: 10 });
    await lift({ lift_time: '18:00', description: 'رفع خزان مياه', load_t: 4, radius_m: 15 });
    await call('POST', `/v1/cranes/lifts/${l1.id}/approve`, {}, T);
  }],
  concrete: ['الخرسانة الجاهزة', ['concrete'], async ({ T, le, w }) => {
    const mixer = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'mixer', plate_no: plate('MX'), capacity: { m3: 9 } }, T);
    const d = await w('driver', 'فهد المطيري');
    const pour = await call('POST', '/v1/concrete/pours', { legal_entity_id: le, ref: `RM-${stamp}`, mix_code: 'C35', volume_m3: 12, pour_rate_m3h: 30, scheduled_at: inMin(60),
      site: { name: 'برج الريم', area: 'الشرق', lat: 29.375, lng: 47.99, contact_name: 'م. خالد', contact_phone: '50000009' } }, T);
    const load = pour.loads[0];
    await call('POST', `/v1/tasks/${load.task_id}/assign`, { version: load.version, worker_id: d.id, asset_id: mixer.id }, T);
  }],
  internal: ['أسطول الشركة الداخلي', ['internal'], async ({ T, le, w }) => {
    const dept = await call('POST', '/v1/internal/departments', { legal_entity_id: le, name: 'العلاقات العامة' }, T);
    const van = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'van', plate_no: plate('IN'), odometer_km: 30_000 }, T);
    const d = await w('driver', 'سعد سائق الشركة');
    let vr = await call('POST', '/v1/internal/requests', { purpose: 'استقبال وفد في المطار', destination: 'مطار الكويت', with_driver: true, passengers: 5, department_id: dept.id, starts_at: inMin(60), ends_at: inMin(240) }, T);
    vr = await call('POST', `/v1/internal/requests/${vr.id}/decide`, { version: vr.version, approve: true }, T);
    await call('POST', `/v1/internal/requests/${vr.id}/allocate`, { version: vr.version, asset_id: van.id, driver_worker_id: d.id }, T);
  }],
  service: ['الصيانة الفنية', ['service'], async ({ T, le, w }) => {
    const d = await w('technician', 'فني التكييف');
    const cu = await call('POST', '/v1/customers', { legal_entity_id: le, kind: 'individual', name: 'أم عبدالله' }, T);
    const job = await call('POST', '/v1/service/jobs', { legal_entity_id: le, customer_id: cu.id, site: { name: 'فيلا 12', area: 'مشرف', block: '3', phone: '+96550002222' },
      category: 'ac', priority: 'urgent', problem: 'المكيف لا يبرد', unit: { brand: 'Gree', location: 'الصالة' } }, T);
    await call('POST', `/v1/service/jobs/${job.id}/visits`, { technician_worker_id: d.id }, T);
  }],
  waste: ['جمع النفايات', ['waste'], async ({ T, le, w }) => {
    const truck = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'truck', plate_no: plate('CP') }, T);
    const d = await w('driver', 'سائق الكابسة');
    const cu = await call('POST', '/v1/customers', { legal_entity_id: le, name: 'جمعية السالمية' }, T);
    const route = await call('POST', '/v1/waste/routes', { legal_entity_id: le, code: 'SAL-1', name: 'السالمية', start_time: hm(30), duration_min: 300, facility: 'مردم الجهراء', asset_id: truck.id, driver_worker_id: d.id }, T);
    await call('POST', `/v1/waste/routes/${route.id}/points`, { name: 'جمعية السالمية الرئيسي', area: 'السالمية', customer_id: cu.id, bins: [{ type: 'bin_1100', count: 4 }] }, T);
    await call('POST', `/v1/waste/routes/${route.id}/points`, { name: 'فرع الجمعية ق 10', area: 'السالمية', customer_id: cu.id, bins: [{ type: 'bin_240', count: 6 }], note: 'المدخل الخلفي' }, T);
    await call('POST', '/v1/waste/runs/generate', { date: kwDay() }, T);
  }],
  utilities: ['أعمال المرافق', ['utilities'], async ({ T, le, w }) => {
    const van = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'pickup', plate_no: plate('UT') }, T);
    const d = await w('technician', 'رئيس الفرقة');
    const cu = await call('POST', '/v1/customers', { legal_entity_id: le, name: 'وزارة الكهرباء والماء' }, T);
    const job = await call('POST', '/v1/utilities/jobs', { legal_entity_id: le, customer_id: cu.id, network: 'water', job_type: 'repair', priority: 'urgent',
      reported_at: inMin(-30), area: 'الجابرية', address: 'ق 1 ش 5', asset_ref: 'WM-JAB-07', description: 'تسريب في خط مياه 200 مم', affected: 60 }, T);
    await call('POST', `/v1/utilities/jobs/${job.id}/assign`, { worker_id: d.id, asset_id: van.id }, T);
  }],
  security: ['الحراسة والدوريات', ['security'], async ({ T, le, w }) => {
    const d = await w('guard', 'الحارس سالم');
    const cu = await call('POST', '/v1/customers', { legal_entity_id: le, name: 'مجمع الأفنيوز' }, T);
    const site = await call('POST', '/v1/security/sites', { legal_entity_id: le, code: 'AVN', name: 'الأفنيوز: المواقف', customer_id: cu.id, area: 'الري', patrol_times: [hm(30), hm(240)], duration_min: 60,
      guard_worker_id: d.id, instructions: 'تأكد من إغلاق باب المخزن' }, T);
    for (const [name, tag] of [['البوابة الرئيسية', 'CP-GATE'], ['المخزن', 'CP-STORE'], ['السطح', 'CP-ROOF']]) await call('POST', `/v1/security/sites/${site.id}/checkpoints`, { name, tag }, T);
    await call('POST', '/v1/security/patrols/generate', { date: kwDay() }, T);
  }],
  pest: ['مكافحة الحشرات', ['pest'], async ({ T, le, w }) => {
    const d = await w('technician', 'الفني خالد');
    await call('POST', '/v1/documents', { worker_id: d.id, doc_type: 'pesticide_license', number: 'PL-2231', expires_on: until }, T);
    await call('POST', '/v1/pest/products', { name: 'جل الصراصير', registration_no: 'KM-PC-1102', unit: 'g', reentry_hours: 0 }, T);
    await call('POST', '/v1/pest/products', { name: 'رش متبقي', registration_no: 'KM-PC-0877', unit: 'ml', reentry_hours: 4 }, T);
    const cu = await call('POST', '/v1/customers', { legal_entity_id: le, name: 'مطعم البحر' }, T);
    const job = await call('POST', '/v1/pest/jobs', { legal_entity_id: le, customer_id: cu.id, premises: 'restaurant', service: 'spray', pests: ['cockroaches', 'rodents'], area: 'السالمية',
      address: 'شارع البلاجات', scheduled_at: inMin(60), repeat_days: 30, notes: 'المطبخ يغلق 3 العصر' }, T);
    await call('POST', `/v1/pest/jobs/${job.id}/assign`, { worker_id: d.id }, T);
  }],
  landscape: ['تنسيق الحدائق', ['landscape'], async ({ T, le, w }) => {
    const d = await w('technician', 'رئيس الطاقم راجو');
    const cu = await call('POST', '/v1/customers', { legal_entity_id: le, name: 'فيلا العتيبي' }, T);
    await call('POST', '/v1/landscape/sites', { legal_entity_id: le, code: 'V1', name: 'فيلا العتيبي: الحديقة الأمامية', customer_id: cu.id, area: 'الشويخ', area_m2: 400,
      services: ['mowing', 'pruning', 'irrigation'], days: [1, 2, 3, 4, 5, 6, 7], visit_time: hm(60), duration_min: 180, lead_worker_id: d.id, crew_size: 3, instructions: 'لا تقصوا النخلة' }, T);
    await call('POST', '/v1/landscape/visits/generate', { date: kwDay() }, T);
  }],
  distribution: ['التوزيع اليومي', ['distribution'], async ({ T, le, w }) => {
    await call('POST', '/v1/distribution/products', { legal_entity_id: le, sku: 'MLK', name: 'حليب', unit: 'carton', price: '0.350' }, T);
    await call('POST', '/v1/distribution/products', { legal_entity_id: le, sku: 'LBN', name: 'لبن', unit: 'carton', price: '0.250' }, T);
    const truck = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'truck', plate_no: plate('DS'), odometer_km: 50_000 }, T);
    const d = await w('driver', 'مبارك');
    await call('POST', '/v1/distribution/routes', { legal_entity_id: le, route_date: kwDay(), asset_id: truck.id, driver_worker_id: d.id, start_time: '00:00', end_time: '23:59',
      stops: [{ name: 'فرع السالمية', items: [{ sku: 'MLK', qty: 20 }, { sku: 'LBN', qty: 10 }] }, { name: 'بقالة الرميثية', payment: 'cash', items: [{ sku: 'MLK', qty: 10 }] }] }, T);
  }],
};

const pick = (process.argv[2] ?? 'all').split(',');
const names = pick.includes('all') ? Object.keys(SECTORS) : pick;
for (const n of names) if (!SECTORS[n]) throw new Error(`unknown sector ${n}; one of: ${Object.keys(SECTORS).join(', ')}`);

const user = await ownerToken();
const done = [];
for (const code of names) {
  const [label, packs, seed] = SECTORS[code];
  try {
    const co = await call('POST', '/v1/tenants', { name: `عرض: ${label}`, packs }, user);
    const T = co.access_token, le = co.legal_entity_id;
    let first = true;
    const w = async (kind, name, login = true) => {
      const email = login && first ? `driver-${code}@demo.q8hub.com` : undefined;
      if (email) first = false;
      return call('POST', '/v1/workers', { legal_entity_id: le, kind, display_name: name, ...(email ? { email, password: DEMO_PASSWORD } : {}) }, T);
    };
    await seed({ T, le, w });
    done.push(code);
    console.log(`✓ ${label} (${code}): driver-${code}@demo.q8hub.com`);
  } catch (e) {
    console.log(`✗ ${label} (${code}): ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${done.length} of ${names.length} demo companies created (run ${stamp}).`);
