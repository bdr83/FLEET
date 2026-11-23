import 'package:material_ui/material_ui.dart';
import 'package:url_launcher/url_launcher.dart';
import '../core/models.dart';
import 'deliver.dart';
import 'stop.dart';
import 'ticket.dart';
import 'theme.dart';

class TaskScreen extends StatelessWidget {
  const TaskScreen({super.key, required this.taskId});
  final String taskId;

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final t = s.task(taskId);
    if (t == null) {
      return Scaffold(appBar: AppBar(), body: const Center(child: Text('انتهت المهمة أو لم تعد مسندة إليك')));
    }
    final text = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: Text(t.ref ?? 'المهمة')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Wrap(spacing: 8, children: [
          Chip(label: Text(statusLabels[t.status] ?? t.status)),
          if (t.stage != null) Chip(label: Text(stageLabels[t.stage] ?? t.stage!), avatar: const Icon(Icons.flag_outlined, size: 18)),
          if (t.hasProof) const Chip(label: Text('الإثبات مسجّل'), avatar: Icon(Icons.verified_outlined, size: 18)),
          if (s.queue.hasPendingFor(t.id)) const Chip(label: Text('بانتظار الإرسال'), avatar: Icon(Icons.schedule_send, size: 18)),
        ]),
        const SizedBox(height: 12),
        if (t.isConcrete) ...[
          if (!t.siteReady)
            Card(color: Theme.of(context).colorScheme.errorContainer, child: const ListTile(
              leading: Icon(Icons.pan_tool_outlined), title: Text('أوقف المكتب الإرسال: الموقع غير جاهز'), subtitle: Text('انتظر تعليمات المجدول قبل التحميل'))),
          Card(key: const Key('load-card'), child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('الحمولة', style: text.labelMedium),
            Row(children: [Ltr(_m3(t.volumeM3), style: text.headlineSmall), const SizedBox(width: 12), if (t.mixCode != null) Chip(label: Text('خلطة ${t.mixCode}'))]),
            if (t.ticketNo != null) Row(children: [const Text('رقم التذكرة: '), Ltr(t.ticketNo!)]),
            if (t.plannedArrival != null) Text('الوصول المطلوب للموقع: ${kwTime(t.plannedArrival)}'),
            if (t.batchedAt != null) _Age(batchedAt: t.batchedAt!),
          ]))),
          const SizedBox(height: 12),
        ],
        if (t.isFreight) ...[
          Card(key: const Key('freight-card'), child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('بوليصة النقل', style: text.labelMedium),
            if (t.waybillNo != null) Ltr(t.waybillNo!, style: text.headlineSmall),
            Text('${t.cargo['description'] ?? ''}${t.cargo['packages'] != null ? ' · ${t.cargo['packages']} طرد' : ''}', style: text.titleMedium),
            if (t.cargo['weight_kg'] != null) Row(children: [const Text('الوزن المعلن: '), Ltr('${t.cargo['weight_kg']} kg')]),
            if (t.trailerPlate != null) Row(children: [const Text('المقطورة: '), Ltr(t.trailerPlate!)]),
            if (t.freight?['seal_no'] != null) Row(children: [const Text('رقم الختم: '), Ltr('${t.freight!['seal_no']}')]),
            const SizedBox(height: 6),
            Text('التحميل من', style: text.labelMedium),
            Text(t.pickupLine.isEmpty ? '—' : t.pickupLine),
            const SizedBox(height: 4),
            const Text('سجّل الوصول والتحميل بالوزن والختم، ثم الوصول للتفريغ واسم المستلم. الانتظار بعد الوقت المجاني يُحتسب على العميل.'),
          ]))),
          const SizedBox(height: 12),
        ],
        if (t.isStaffing) ...[
          Card(key: const Key('shift-card'), child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('مناوبة لدى العميل', style: text.labelMedium),
            if (t.shift != null) Row(children: [const Text('الدوام: '), Ltr(t.shift!, style: text.headlineSmall)]),
            if (t.workDate != null) Row(children: [const Text('اليوم: '), Ltr(t.workDate!)]),
            if (t.requestRef != null) Row(children: [const Text('الطلب: '), Ltr(t.requestRef!)]),
            const SizedBox(height: 4),
            const Text('سجّل الحضور عند وصولك لموقع العميل، والانصراف عند نهاية الدوام. يُحسب الوقت بينهما ساعات عمل.'),
            if (['assigned', 'accepted'].contains(t.status) && !checkInOpen(t, DateTime.now()))
              Padding(padding: const EdgeInsets.only(top: 8), child: Text('يفتح تسجيل الحضور ${kwTime(t.windowFrom!.subtract(earlyCheckIn), date: true)}',
                  key: const Key('checkin-opens'), style: const TextStyle(fontWeight: FontWeight.bold))),
          ]))),
          const SizedBox(height: 12),
        ],
        if (t.isRoute) ...[
          Card(key: const Key('route-card'), child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('مسار التوزيع · ${t.stopsCount} توقفات', style: text.labelMedium),
            const SizedBox(height: 4),
            Text('قائمة التحميل', style: text.titleMedium),
            for (final i in t.loadList) Row(children: [Expanded(child: Text(i.name)), Ltr(qtyText(i.qty), style: const TextStyle(fontWeight: FontWeight.bold))]),
            const SizedBox(height: 6),
            Text(t.status == 'accepted' && t.stage == null
                ? 'راجع الحمولة على الشاحنة مع القائمة وسجّل العدّاد قبل الانطلاق.'
                : t.status == 'in_progress' ? 'سلّم التوقفات بالترتيب، ثم سجّل العودة للمستودع بالعدّاد.' : 'انطلق عندما تكون جاهزًا.'),
            if (t.isCold) ...[
              const SizedBox(height: 8),
              Row(children: [const Icon(Icons.ac_unit, size: 18), const SizedBox(width: 6), Text('${tempClassLabels[t.tempClass] ?? t.tempClass} · '),
                Ltr('${t.tempMin?.toStringAsFixed(0) ?? ''}° .. ${t.tempMax?.toStringAsFixed(0) ?? ''}°')]),
              if (['accepted', 'in_progress'].contains(t.status))
                Padding(padding: const EdgeInsets.only(top: 6), child: OutlinedButton.icon(key: const Key('temp-reading'), icon: const Icon(Icons.thermostat),
                    label: const Text('تسجيل الحرارة'), onPressed: () => _temp(context, t))),
            ],
          ]))),
          const SizedBox(height: 12),
        ],
        if (t.isStop) ...[
          Card(key: const Key('stop-card'), child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('التوقف ${t.seq ?? ''} من المسار ${t.routeRef ?? ''}', style: text.labelMedium),
            Text(t.payCash ? 'الدفع نقدًا عند التسليم' : 'على الحساب (بلا تحصيل)', style: TextStyle(fontWeight: FontWeight.bold, color: t.payCash ? Theme.of(context).colorScheme.tertiary : null)),
            const SizedBox(height: 4),
            for (final i in t.distItems) Row(children: [Expanded(child: Text(i.expiry != null ? '${i.name} · صلاحية ${i.expiry}' : i.name)), Ltr(qtyText(i.qty))]),
            if (t.status == 'assigned') const Padding(padding: EdgeInsets.only(top: 8), child: Text('يُفتح التسليم بعد الانطلاق من المستودع', style: TextStyle(fontWeight: FontWeight.bold))),
          ]))),
          const SizedBox(height: 12),
        ],
        if (t.isInternal) ...[
          Card(key: const Key('trip-card'), child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('مشوار لموظف في الشركة', style: text.labelMedium),
            if (t.purpose != null) Text(t.purpose!, style: text.titleLarge),
            if (t.department != null) Text('الإدارة: ${t.department}'),
            if (t.passengers != null) Row(children: [const Text('الركاب: '), Ltr('${t.passengers}')]),
            const SizedBox(height: 4),
            const Text('سجّل قراءة العدّاد عند استلام المركبة وعند إرجاعها. المسافة بينهما تُحمّل على الإدارة.'),
          ]))),
          const SizedBox(height: 12),
        ],
        if (t.isEquipment) ...[
          Card(key: const Key('hire-card'), child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('تأجير معدة · ${t.attributes['hire_ref'] ?? ''}', style: text.labelMedium),
            Row(children: [Text(machineTypeLabels[t.attributes['machine_type']] ?? '${t.attributes['machine_type'] ?? ''}', style: text.titleLarge), const SizedBox(width: 8),
              if (t.attributes['machine'] != null) Ltr('${t.attributes['machine']}', style: text.titleMedium)]),
            if (t.shift != null) Row(children: [const Text('الدوام: '), Ltr(t.shift!, style: const TextStyle(fontWeight: FontWeight.bold))]),
            if (t.minHours != null && t.minHours! > 0) Text('الحد الأدنى اليومي ${qtyText(t.minHours!)} ساعات'),
            const SizedBox(height: 4),
            const Text('سجّل عدّاد الساعات عند بدء العمل وعند انتهائه، وساعات توقف الأعطال، واسم مشرف الموقع الذي أقرّ الساعات.'),
          ]))),
          const SizedBox(height: 12),
        ],
        if (t.isService) ...[
          Card(key: const Key('visit-card'), child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Row(children: [Expanded(child: Text('بلاغ صيانة · ${t.attributes['job_ref'] ?? ''} · الزيارة ${t.attributes['seq'] ?? 1}', style: text.labelMedium)),
              if (t.urgent) Text('عاجل', style: TextStyle(fontWeight: FontWeight.bold, color: Theme.of(context).colorScheme.error))]),
            Text(serviceCategoryLabels[t.category] ?? t.category ?? '', style: text.titleLarge),
            if (t.problem != null) Text(t.problem!, style: text.titleMedium),
            if (t.unit != null) Text([t.unit!['brand'], t.unit!['model'], t.unit!['location']].whereType<String>().join(' · ')),
            if (t.attributes['customer_name'] != null) Text('العميل: ${t.attributes['customer_name']}'),
            if (t.attributes['contact_phone'] != null) Row(children: [const Text('الهاتف: '), Ltr('${t.attributes['contact_phone']}')]),
            if (t.previousVisits.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text('الزيارات السابقة', style: text.labelMedium),
              for (final p in t.previousVisits) Text(p),
            ],
          ]))),
          const SizedBox(height: 12),
        ],
        if (t.isTanker) ...[
          Card(key: const Key('tanker-card'), child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('صهريج · ${t.attributes['order_ref'] ?? ''}', style: text.labelMedium),
            Text(tankerProductLabels[t.product] ?? t.product ?? '', style: text.titleLarge),
            if (t.qtyL != null) Row(children: [const Text('الكمية: '), Ltr('${t.qtyL} L', style: text.headlineSmall)]),
            if (t.capacityL != null) Text('سعة الصهريج ${t.capacityL} لتر'),
            if (t.attributes['customer_name'] != null) Text('العميل: ${t.attributes['customer_name']}'),
            if (t.attributes['contact_phone'] != null) Row(children: [const Text('الهاتف: '), Ltr('${t.attributes['contact_phone']}')]),
            if (t.attributes['notes'] != null) Text('${t.attributes['notes']}'),
            const SizedBox(height: 4),
            const Text('سجّل اللترات المعبأة من العدّاد ومحطة التعبئة، ثم اللترات المفرّغة واسم المستلم.'),
          ]))),
          const SizedBox(height: 12),
        ],
        if (t.isContainer) ...[
          Card(key: const Key('container-card'), child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('حاوية · ${t.attributes['job_ref'] ?? ''} · ${containerLegLabels[t.attributes['leg']] ?? ''}', style: text.labelMedium),
            if (t.containerNo != null) Ltr(t.containerNo!, style: text.headlineSmall),
            Text('${t.attributes['iso_size'] ?? ''} قدم · ${containerTypeLabels[t.attributes['ctype']] ?? ''}${t.attributes['line'] != null ? ' · ${t.attributes['line']}' : ''}', style: text.titleMedium),
            if (t.attributes['doc_no'] != null) Row(children: [const Text('البوليصة: '), Ltr('${t.attributes['doc_no']}')]),
            if (t.attributes['seal_no'] != null) Row(children: [const Text('الختم: '), Ltr('${t.attributes['seal_no']}')]),
            if (t.attributes['customer_name'] != null) Text('العميل: ${t.attributes['customer_name']}'),
            if (t.attributes['contact_phone'] != null) Row(children: [const Text('الهاتف: '), Ltr('${t.attributes['contact_phone']}')]),
            const SizedBox(height: 6),
            Text('السحب من', style: text.labelMedium),
            Text(t.pickupLine.isEmpty ? '—' : t.pickupLine),
            const SizedBox(height: 4),
            Text(t.needsGateRef ? 'اكتب رقم الحاوية عند سحبها، ورقم إيصال البوابة عند التسليم.' : 'اكتب رقم الحاوية عند سحبها، واسم المستلم عند التسليم.'),
          ]))),
          const SizedBox(height: 12),
        ],
        if (t.isMoving || t.isMoveCrew) ...[
          Card(key: const Key('move-card'), child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('نقل أثاث · ${t.attributes['move_ref'] ?? ''}${t.isMoveCrew ? ' · ضمن الطاقم' : ''}', style: text.labelMedium),
            if (t.attributes['home_size'] != null) Text(moveSizeLabels[t.attributes['home_size']] ?? '${t.attributes['home_size']}', style: text.titleLarge),
            if (t.attributes['items_count'] is num && (t.attributes['items_count'] as num) > 0)
              Text('${t.attributes['items_count']} قطعة${t.attributes['volume_m3'] is num ? ' · ${t.attributes['volume_m3']} م³' : ''}'),
            if (t.fragileItems.isNotEmpty) Text('قابل للكسر: ${t.fragileItems.join('، ')}', style: TextStyle(color: Theme.of(context).colorScheme.error)),
            if ((t.attributes['services'] as List?)?.isNotEmpty ?? false) Text([for (final x in t.attributes['services'] as List) moveServiceLabels[x] ?? '$x'].join(' · ')),
            if (t.attributes['customer_name'] != null) Text('العميل: ${t.attributes['customer_name']}'),
            if (t.attributes['contact_phone'] != null) Row(children: [const Text('الهاتف: '), Ltr('${t.attributes['contact_phone']}')]),
            if (t.attributes['crew'] is num && (t.attributes['crew'] as num) > 0) Text('معك ${t.attributes['crew']} عمال'),
            if (t.attributes['notes'] != null) Text('${t.attributes['notes']}'),
            const SizedBox(height: 6),
            Text('التحميل من', style: text.labelMedium),
            Text(t.pickupLine.isEmpty ? '—' : t.pickupLine),
            if (t.isMoving) ...[const SizedBox(height: 4), const Text('سجّل انتهاء التحميل، ثم انتهاء التفريغ واسم المستلم وأي ضرر لاحظته.')],
          ]))),
          const SizedBox(height: 12),
        ],
        if (t.isRental) ...[
          Card(key: const Key('rental-card'), child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('تأجير سيارة · ${t.rentalRef ?? ''}', style: text.labelMedium),
            Text(t.isCollect ? 'استلام السيارة من العميل' : 'توصيل السيارة للعميل', style: text.titleLarge),
            Row(children: [if (t.attributes['vehicle'] != null) Text('${t.attributes['vehicle']} '), if (t.attributes['plate_no'] != null) Ltr('${t.attributes['plate_no']}', style: text.titleMedium)]),
            if (t.renterName != null) Text('المستأجر: ${t.renterName}'),
            if (t.renterPhone != null) Row(children: [const Text('الهاتف: '), Ltr(t.renterPhone!)]),
            if (t.isCollect && t.attributes['out_odometer_km'] != null)
              Row(children: [const Text('عند التسليم: '), Ltr('${t.attributes['out_odometer_km']} كم'), if (t.attributes['out_fuel'] is num) Text(' · الوقود ${fuelLabel((t.attributes['out_fuel'] as num).toInt())}')]),
            const SizedBox(height: 4),
            Text(t.isCollect ? 'سجّل قراءة العدّاد والوقود عند استلام السيارة، واكتب أي ضرر جديد.' : 'تحقق من رخصة المستأجر، وسجّل العدّاد والوقود واسم المستلم عند التسليم.'),
          ]))),
          const SizedBox(height: 12),
        ],
        if (t.isSchool) ...[
          _SchoolCard(t: t),
          const SizedBox(height: 12),
        ],
        if (t.isShuttle) ...[
          _ShuttleCard(t: t),
          const SizedBox(height: 12),
        ],
        Card(child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(t.isConcrete || t.isStaffing ? 'الموقع' : t.isInternal ? 'الوجهة' : t.isFreight || t.isMoving || t.isMoveCrew ? 'التفريغ في' : t.isContainer ? 'التسليم في' : 'العنوان', style: text.labelMedium),
          Text(t.address.isEmpty ? '—' : t.address, style: text.titleMedium),
          if (t.notes != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(t.notes!)),
          if (t.windowFrom != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text('الموعد: ${kwTime(t.windowFrom, date: true)} إلى ${kwTime(t.windowTo)}')),
          const SizedBox(height: 12),
          OutlinedButton.icon(onPressed: () => _navigate(t), icon: const Icon(Icons.navigation_outlined), label: const Text('الملاحة')),
        ]))),
        const SizedBox(height: 12),
        if ((t.isConcrete || t.isStaffing) && (t.siteContact != null || t.sitePhone != null))
          Card(child: ListTile(
            leading: Icon(t.isStaffing ? Icons.badge_outlined : Icons.engineering_outlined),
            title: Text(t.siteContact ?? (t.isStaffing ? 'المسؤول لدى العميل' : 'مهندس الموقع')),
            subtitle: t.sitePhone == null ? null : Ltr(t.sitePhone!),
            trailing: t.sitePhone == null ? null : IconButton.filledTonal(
              tooltip: 'اتصال', icon: const Icon(Icons.call), onPressed: () => launchUrl(Uri.parse('tel:${t.sitePhone}'))),
          )),
        if (t.isInternal && t.requester != null)
          Card(child: ListTile(
            leading: const Icon(Icons.person_outline),
            title: Text(t.requester!),
            subtitle: t.requesterPhone == null ? null : Ltr(t.requesterPhone!),
            trailing: t.requesterPhone == null ? null : IconButton.filledTonal(
              tooltip: 'اتصال', icon: const Icon(Icons.call), onPressed: () => launchUrl(Uri.parse('tel:${t.requesterPhone}'))),
          )),
        if (t.parcelLine != null)
          Card(key: const Key('parcel-card'), child: ListTile(leading: const Icon(Icons.inventory_2_outlined), title: Ltr(t.awb!),
              subtitle: Text(t.attempt > 1 ? '${t.parcelLine!}\nمحاولة تسليم جديدة بعد محاولة لم تنجح' : t.parcelLine!))),
        if (!t.isConcrete && !t.isStaffing && !t.isInternal && (t.recipientName != null || t.recipientPhone != null))
          Card(child: ListTile(
            leading: const Icon(Icons.person_outline),
            title: Text(t.recipientName ?? 'المستلم'),
            subtitle: t.recipientPhone == null ? null : Ltr(t.recipientPhone!),
            trailing: t.recipientPhone == null ? null : IconButton.filledTonal(
              tooltip: 'اتصال', icon: const Icon(Icons.call), onPressed: () => launchUrl(Uri.parse('tel:${t.recipientPhone}'))),
          )),
        if (t.codFils > 0) ...[
          const SizedBox(height: 12),
          Card(child: ListTile(
            leading: const Icon(Icons.payments_outlined),
            title: const Text('مبلغ التحصيل عند التسليم'),
            trailing: Ltr('${filsToMoney(t.codFils)} KWD', style: text.titleLarge),
          )),
        ],
        const SizedBox(height: 24),
        _Actions(task: t),
      ]),
    );
  }

  /// Cold chain: the driver types the temperature shown on the truck's fridge display.
  Future<void> _temp(BuildContext context, DriverTask t) async {
    final s = AppScope.of(context);
    final c = TextEditingController();
    final v = await showModalBottomSheet<double>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(builder: (ctx, set) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('حرارة الثلاجة', style: Theme.of(ctx).textTheme.titleLarge),
          TextField(key: const Key('celsius'), controller: c, autofocus: true, textDirection: TextDirection.ltr,
              keyboardType: const TextInputType.numberWithOptions(decimal: true, signed: true), decoration: const InputDecoration(labelText: 'الحرارة (°C)'), onChanged: (_) => set(() {})),
          const SizedBox(height: 12),
          FilledButton(key: const Key('celsius-save'), onPressed: parseCelsius(c.text) == null ? null : () => Navigator.pop(ctx, parseCelsius(c.text)), child: const Text('تسجيل')),
        ]),
      )),
    );
    if (v == null || !context.mounted) return;
    final err = await s.tempReading(t.id, v);
    if (!context.mounted) return;
    if (err != null) return toast(context, err, error: true);
    final out = (t.tempMin != null && v < t.tempMin!) || (t.tempMax != null && v > t.tempMax!);
    toast(context, out ? 'سُجّلت $v° وهي خارج النطاق: أبلغ المكتب' : 'سُجّلت $v°', error: out);
  }

  Future<void> _navigate(DriverTask t) async {
    final p = t.target;
    final uri = p != null
        ? Uri.parse('https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}')
        : Uri.parse('https://www.google.com/maps/search/?api=1&query=${Uri.encodeComponent('${t.address}، الكويت')}');
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }
}

String _m3(double v) => '${v.toStringAsFixed(v == v.roundToDouble() ? 0 : 2)} م³';

/// Concrete age since batching, refreshed every 30 seconds. The limit is set by the plant; the office sees the alert too.
class _Age extends StatefulWidget {
  const _Age({required this.batchedAt});
  final DateTime batchedAt;
  @override
  State<_Age> createState() => _AgeState();
}

class _AgeState extends State<_Age> {
  late final Stream<int> _tick = Stream.periodic(const Duration(seconds: 30), (i) => i);
  @override
  Widget build(BuildContext context) => StreamBuilder(stream: _tick, builder: (context, _) {
        final m = DateTime.now().difference(widget.batchedAt).inMinutes;
        return Text('عمر الخرسانة: $m دقيقة منذ التحميل', key: const Key('age'), style: TextStyle(fontWeight: FontWeight.bold, color: m >= 70 ? Theme.of(context).colorScheme.error : null));
      });
}

/// The next steps for the task. One action at a time: buttons are disabled until the last tap is recorded.
class _Actions extends StatefulWidget {
  const _Actions({required this.task});
  final DriverTask task;
  @override
  State<_Actions> createState() => _ActionsState();
}

class _ActionsState extends State<_Actions> {
  bool _busy = false;
  DriverTask get task => widget.task;

  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (final a in nextActions(task)) Padding(padding: const EdgeInsets.only(bottom: 10), child: _button(context, a)),
      ]);

  Widget _button(BuildContext context, TaskAction action) {
    final label = Text(actionLabel(task, action));
    final key = Key('action-${action.name}');
    switch (action) {
      case TaskAction.fail:
        return OutlinedButton(key: key, onPressed: _busy ? null : () => _guard(() => _fail(context)), style: OutlinedButton.styleFrom(foregroundColor: Theme.of(context).colorScheme.error), child: label);
      case TaskAction.deliver:
        return FilledButton.icon(key: key, icon: const Icon(Icons.check_circle_outline), label: label,
            onPressed: _busy ? null : () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => DeliverScreen(taskId: task.id))));
      case TaskAction.ticket:
        return FilledButton.icon(key: key, icon: const Icon(Icons.draw_outlined), label: label,
            onPressed: _busy ? null : () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => TicketScreen(taskId: task.id))));
      default:
        return FilledButton(key: key, onPressed: _busy ? null : () => _guard(() => _do(context, action)), child: label);
    }
  }

  Future<void> _guard(Future<void> Function() f) async {
    setState(() => _busy = true);
    try {
      await f();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _do(BuildContext context, TaskAction action) async {
    final s = AppScope.of(context);
    switch (action) {
      case TaskAction.accept: await s.setStatus(task.id, 'accepted');
      case TaskAction.start: await s.setStatus(task.id, 'in_progress');
      case TaskAction.complete:
        final block = task.isSchool ? task.schoolFinishBlock : null;
        if (block != null) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(rejectReasons[block] ?? block)));
          return;
        }
        await s.setStatus(task.id, 'completed');
      case TaskAction.atPickup: await s.milestone(task.id, 'at_pickup');
      case TaskAction.pickedUp:
        await s.milestone(task.id, 'picked_up');
      case TaskAction.atDropoff: await s.milestone(task.id, 'at_dropoff');
      case TaskAction.loaded:
        if (!task.isFreight) {
          await s.milestone(task.id, 'loaded');
          return;
        }
        final r = await _cargoForm(context, 'التحميل', 'تأكيد التحميل', receiver: false);
        if (r == null) return;
        await s.milestone(task.id, 'loaded', extra: {'weight_kg': ?r.weightKg, 'seal_no': ?r.seal});
      case TaskAction.tankFilled:
      case TaskAction.tankDischarged:
        final fill = action == TaskAction.tankFilled;
        final r = await _tankForm(context, fill: fill);
        if (r == null) return;
        final err = fill ? await s.tankFilled(task.id, litres: r.litres, source: r.text) : await s.tankDischarged(task.id, litres: r.litres, receivedBy: r.text!);
        if (!context.mounted) return;
        if (err != null) return toast(context, err, error: true);
        if (!fill) {
          toast(context, s.offline ? 'سُجّل التفريغ وسيُرسل عند عودة الاتصال' : 'تم التفريغ وانتهى الطلب');
          Navigator.of(context).pop();
        }
      case TaskAction.ctrPicked:
        final r = await _ctrForm(context, pick: true);
        if (r == null) return;
        final err = await s.containerPicked(task.id, containerNo: r.a, sealNo: r.b);
        if (err != null && context.mounted) toast(context, err, error: true);
      case TaskAction.ctrDropped:
        final r = await _ctrForm(context, pick: false);
        if (r == null) return;
        final err = task.needsGateRef ? await s.containerDropped(task.id, gateRef: r.a) : await s.containerDropped(task.id, receivedBy: r.a);
        if (!context.mounted) return;
        if (err != null) return toast(context, err, error: true);
        toast(context, s.offline ? 'سُجّل التسليم وسيُرسل عند عودة الاتصال' : 'سُلّمت الحاوية وانتهت الرحلة');
        Navigator.of(context).pop();
      case TaskAction.unloaded when task.isMoving:
        final r = await _moveForm(context);
        if (r == null) return;
        final err = await s.moveDone(task.id, receivedBy: r.receiver, note: r.note);
        if (!context.mounted) return;
        if (err != null) return toast(context, err, error: true);
        toast(context, s.offline ? 'سُجّل التسليم وسيُرسل عند عودة الاتصال' : 'انتهى النقل وأُرسل للمكتب');
        Navigator.of(context).pop();
      case TaskAction.unloaded:
        final r = await _cargoForm(context, 'التفريغ والتسليم', 'تأكيد التسليم', receiver: true);
        if (r == null) return;
        await s.milestone(task.id, 'unloaded', extra: {'received_by': r.receiver, 'weight_kg': ?r.weightKg});
      case TaskAction.atSite: await s.milestone(task.id, 'at_site');
      case TaskAction.pourStart: await s.milestone(task.id, 'pour_start');
      case TaskAction.pourEnd: await s.milestone(task.id, 'pour_end');
      case TaskAction.checkIn: await s.checkIn(task.id);
      case TaskAction.checkOut:
        await s.checkOut(task.id);
        if (context.mounted) {
          toast(context, s.offline ? 'سُجّل الانصراف وسيُرسل عند عودة الاتصال' : 'سُجّل الانصراف. يومك بانتظار اعتماد العميل');
          Navigator.of(context).pop();
        }
      case TaskAction.loadChecked:
        final reading = await _odometer(context, 'مراجعة الحمولة', 'تأكيد', fuel: false);
        if (reading == null) return;
        final err = await s.loadChecked(task.id, odometerKm: reading.km);
        if (err != null && context.mounted) toast(context, err, error: true);
      case TaskAction.depart: await s.depart(task.id);
      case TaskAction.routeBack:
        final reading = await _odometer(context, 'العودة للمستودع', 'تأكيد العودة', fuel: false);
        if (reading == null) return;
        final err = await s.routeBack(task.id, odometerKm: reading.km);
        if (!context.mounted) return;
        if (err != null) return toast(context, err, error: true);
        toast(context, 'انتهى المسار. سلّم النقد والمرتجعات للمكتب');
        Navigator.of(context).pop();
      case TaskAction.stopDeliver:
        await Navigator.of(context).push(MaterialPageRoute(builder: (_) => StopScreen(taskId: task.id)));
        if (context.mounted && s.task(task.id) == null) Navigator.of(context).pop();
      case TaskAction.vehicleOut:
      case TaskAction.vehicleBack:
        final out = action == TaskAction.vehicleOut;
        final reading = await _odometer(context, out ? 'استلام المركبة' : 'إرجاع المركبة', out ? 'تأكيد الاستلام' : 'تأكيد الإرجاع');
        if (reading == null) return;
        final err = out
            ? await s.vehicleOut(task.id, odometerKm: reading.km, fuel: reading.fuel)
            : await s.vehicleBack(task.id, odometerKm: reading.km, fuel: reading.fuel);
        if (!context.mounted) return;
        if (err != null) return toast(context, err, error: true);
        if (!out) {
          toast(context, s.offline ? 'سُجّل الإرجاع وسيُرسل عند عودة الاتصال' : 'أُرجعت المركبة وانتهى المشوار');
          Navigator.of(context).pop();
        }
      case TaskAction.workStart:
      case TaskAction.workEnd:
        final end = action == TaskAction.workEnd;
        final r = await _meterForm(context, end: end);
        if (r == null) return;
        final err = end ? await s.workEnd(task.id, r.meter, downtime: r.downtime, signedBy: r.signer!) : await s.workStart(task.id, r.meter);
        if (!context.mounted) return;
        if (err != null) return toast(context, err, error: true);
        if (end) {
          toast(context, s.offline ? 'سُجّل انتهاء العمل وسيُرسل عند عودة الاتصال' : 'انتهى يوم العمل. الساعات بانتظار اعتماد المكتب');
          Navigator.of(context).pop();
        }
      case TaskAction.arrived: await s.milestone(task.id, 'arrived');
      case TaskAction.workDone:
        final r = await _serviceForm(context);
        if (r == null) return;
        final err = await s.serviceDone(task.id, result: r.result, workDone: r.work, signedBy: r.signer, parts: r.parts);
        if (!context.mounted) return;
        if (err != null) return toast(context, err, error: true);
        toast(context, s.offline ? 'سُجّلت الزيارة وستُرسل عند عودة الاتصال' : 'انتهت الزيارة وأُرسلت للمكتب');
        Navigator.of(context).pop();
      case TaskAction.handover:
      case TaskAction.collected:
        final collect = action == TaskAction.collected;
        final r = await _odometer(context, collect ? 'استلام السيارة من العميل' : 'تسليم السيارة للعميل', collect ? 'تأكيد الاستلام' : 'تأكيد التسليم', receiver: !collect);
        if (r == null) return;
        final err = await s.rentalStep(task.id, collect: collect, odometerKm: r.km, fuel: r.fuel, receivedBy: r.receiver);
        if (!context.mounted) return;
        if (err != null) return toast(context, err, error: true);
        toast(context, s.offline ? 'سُجّل وسيُرسل عند عودة الاتصال' : collect ? 'استُلمت السيارة. أرجعها للفرع' : 'سُلّمت السيارة للعميل');
        Navigator.of(context).pop();
      case TaskAction.returned:
        await s.milestone(task.id, 'returned_to_sender');
        if (context.mounted) Navigator.of(context).pop();
      default:
    }
    if (action == TaskAction.complete && context.mounted) Navigator.of(context).pop();
  }

  /// Freight: weight and seal at loading, or the receiver's name (required) and weight at unloading.
  Future<({double? weightKg, String? seal, String? receiver})?> _cargoForm(BuildContext context, String title, String confirm, {required bool receiver}) {
    final weight = TextEditingController(), other = TextEditingController();
    return showModalBottomSheet<({double? weightKg, String? seal, String? receiver})>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(builder: (ctx, set) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(title, style: Theme.of(ctx).textTheme.titleLarge),
          const SizedBox(height: 8),
          if (receiver) TextField(key: const Key('received-by'), controller: other, autofocus: true, decoration: const InputDecoration(labelText: 'اسم المستلم'), onChanged: (_) => set(() {})),
          TextField(key: const Key('weight-kg'), controller: weight, keyboardType: const TextInputType.numberWithOptions(decimal: true), textDirection: TextDirection.ltr,
              decoration: const InputDecoration(labelText: 'الوزن (كغ) إن وُزنت'), onChanged: (_) => set(() {})),
          if (!receiver) TextField(key: const Key('seal-no'), controller: other, textDirection: TextDirection.ltr, decoration: const InputDecoration(labelText: 'رقم الختم (إن وُجد)')),
          const SizedBox(height: 12),
          FilledButton(
            key: const Key('cargo-save'),
            onPressed: (receiver && other.text.trim().isEmpty) || (weight.text.trim().isNotEmpty && double.tryParse(weight.text.trim()) == null) ? null : () => Navigator.pop(ctx, (
              weightKg: double.tryParse(weight.text.trim()),
              seal: !receiver && other.text.trim().isNotEmpty ? other.text.trim() : null,
              receiver: receiver ? other.text.trim() : null,
            )),
            child: Text(confirm),
          ),
        ]),
      )),
    );
  }

  /// Tanker: litres filled (with the source, optional) or discharged (with the receiver, required).
  Future<({int litres, String? text})?> _tankForm(BuildContext context, {required bool fill}) {
    final l = TextEditingController(text: fill && task.qtyL != null ? '${task.qtyL}' : ''), who = TextEditingController();
    bool ok() => parseLitres(l.text) != null && (fill || who.text.trim().isNotEmpty);
    return showModalBottomSheet<({int litres, String? text})>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(builder: (ctx, set) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(fill ? 'التعبئة' : 'التفريغ', style: Theme.of(ctx).textTheme.titleLarge),
          const SizedBox(height: 8),
          TextField(key: const Key('litres'), controller: l, autofocus: true, keyboardType: TextInputType.number, textDirection: TextDirection.ltr,
              decoration: InputDecoration(labelText: fill ? 'اللترات المعبأة (من العدّاد)' : 'اللترات المفرّغة (من العدّاد)'), onChanged: (_) => set(() {})),
          TextField(key: const Key('tank-text'), controller: who, decoration: InputDecoration(labelText: fill ? 'محطة التعبئة' : 'اسم المستلم'), onChanged: (_) => set(() {})),
          const SizedBox(height: 12),
          FilledButton(
            key: const Key('tank-save'),
            onPressed: ok() ? () => Navigator.pop(ctx, (litres: parseLitres(l.text)!, text: who.text.trim().isEmpty ? null : who.text.trim())) : null,
            child: Text(fill ? 'تأكيد التعبئة' : 'تأكيد التفريغ'),
          ),
        ]),
      )),
    );
  }

  /// Container pickup (the number read on the box, checked here and on the server; the seal) or drop (receiver or gate receipt).
  Future<({String a, String? b})?> _ctrForm(BuildContext context, {required bool pick}) {
    final one = TextEditingController(), two = TextEditingController();
    bool ok() => pick ? normContainer(one.text) != null : one.text.trim().isNotEmpty;
    return showModalBottomSheet<({String a, String? b})>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(builder: (ctx, set) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(pick ? 'سحب الحاوية' : 'تسليم الحاوية', style: Theme.of(ctx).textTheme.titleLarge),
          const SizedBox(height: 8),
          if (pick) ...[
            TextField(key: const Key('container-no'), controller: one, autofocus: true, textDirection: TextDirection.ltr, textCapitalization: TextCapitalization.characters,
                decoration: InputDecoration(labelText: 'رقم الحاوية كما هو عليها', errorText: one.text.trim().length >= 11 && normContainer(one.text) == null ? 'رقم غير صحيح' : null), onChanged: (_) => set(() {})),
            TextField(key: const Key('seal-no'), controller: two, textDirection: TextDirection.ltr, decoration: const InputDecoration(labelText: 'رقم الختم (إن وُجد)')),
          ] else
            TextField(key: const Key('drop-ref'), controller: one, autofocus: true, textDirection: task.needsGateRef ? TextDirection.ltr : null,
                decoration: InputDecoration(labelText: task.needsGateRef ? 'رقم إيصال البوابة (EIR)' : 'اسم المستلم'), onChanged: (_) => set(() {})),
          const SizedBox(height: 12),
          FilledButton(
            key: const Key('ctr-save'),
            onPressed: ok() ? () => Navigator.pop(ctx, (a: pick ? normContainer(one.text)! : one.text.trim(), b: two.text.trim().isEmpty ? null : two.text.trim())) : null,
            child: Text(pick ? 'تأكيد السحب' : 'تأكيد التسليم'),
          ),
        ]),
      )),
    );
  }

  /// End of a move: the receiver's name (required) and any damage or missing item noticed.
  Future<({String receiver, String? note})?> _moveForm(BuildContext context) {
    final who = TextEditingController(), note = TextEditingController();
    return showModalBottomSheet<({String receiver, String? note})>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(builder: (ctx, set) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('التفريغ والتسليم', style: Theme.of(ctx).textTheme.titleLarge),
          const SizedBox(height: 8),
          TextField(key: const Key('received-by'), controller: who, autofocus: true, decoration: const InputDecoration(labelText: 'اسم المستلم'), onChanged: (_) => set(() {})),
          TextField(key: const Key('move-note'), controller: note, maxLength: 500, maxLines: 2, decoration: const InputDecoration(labelText: 'ضرر أو نقص لاحظته (إن وُجد)')),
          const SizedBox(height: 12),
          FilledButton(
            key: const Key('move-save'),
            onPressed: who.text.trim().isEmpty ? null : () => Navigator.pop(ctx, (receiver: who.text.trim(), note: note.text.trim().isEmpty ? null : note.text.trim())),
            child: const Text('تأكيد التسليم'),
          ),
        ]),
      )),
    );
  }

  /// Hired machine: the hour meter, and at the end the downtime from breakdowns and the site supervisor's name (required).
  Future<({double meter, double downtime, String? signer})?> _meterForm(BuildContext context, {required bool end}) {
    final m = TextEditingController(), down = TextEditingController(), who = TextEditingController();
    bool ok() => parseMeter(m.text) != null && (!end || (who.text.trim().isNotEmpty && (down.text.trim().isEmpty || (parseMeter(down.text) ?? 99) <= 24)));
    return showModalBottomSheet<({double meter, double downtime, String? signer})>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(builder: (ctx, set) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(end ? 'انتهاء العمل' : 'بدء العمل', style: Theme.of(ctx).textTheme.titleLarge),
          const SizedBox(height: 8),
          TextField(key: const Key('meter'), controller: m, autofocus: true, keyboardType: const TextInputType.numberWithOptions(decimal: true), textDirection: TextDirection.ltr,
              decoration: const InputDecoration(labelText: 'عدّاد الساعات'), onChanged: (_) => set(() {})),
          if (end) ...[
            TextField(key: const Key('downtime'), controller: down, keyboardType: const TextInputType.numberWithOptions(decimal: true), textDirection: TextDirection.ltr,
                decoration: const InputDecoration(labelText: 'ساعات توقف بسبب عطل (إن وُجدت)'), onChanged: (_) => set(() {})),
            TextField(key: const Key('signer'), controller: who, decoration: const InputDecoration(labelText: 'اسم مشرف الموقع'), onChanged: (_) => set(() {})),
          ],
          const SizedBox(height: 12),
          FilledButton(
            key: const Key('meter-save'),
            onPressed: ok() ? () => Navigator.pop(ctx, (meter: parseMeter(m.text)!, downtime: down.text.trim().isEmpty ? 0.0 : parseMeter(down.text)!, signer: end ? who.text.trim() : null)) : null,
            child: Text(end ? 'تأكيد الانتهاء' : 'تأكيد البدء'),
          ),
        ]),
      )),
    );
  }

  /// End of a service visit: the result, what was done, the parts used and the customer's name (all but parts required).
  Future<({String result, String work, String signer, List<Map<String, dynamic>> parts})?> _serviceForm(BuildContext context) {
    final work = TextEditingController(), who = TextEditingController(), part = TextEditingController(), qty = TextEditingController(text: '1');
    String? result;
    final parts = <Map<String, dynamic>>[];
    return showModalBottomSheet<({String result, String work, String signer, List<Map<String, dynamic>> parts})>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(builder: (ctx, set) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
        child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('نتيجة الزيارة', style: Theme.of(ctx).textTheme.titleLarge),
          Wrap(spacing: 6, children: [
            for (final e in serviceResultLabels.entries) ChoiceChip(key: Key('result-${e.key}'), label: Text(e.value), selected: result == e.key, onSelected: (v) => set(() => result = v ? e.key : null)),
          ]),
          TextField(key: const Key('work-done'), controller: work, maxLength: 500, maxLines: 2, decoration: const InputDecoration(labelText: 'ما تم من عمل'), onChanged: (_) => set(() {})),
          Text('القطع المستخدمة', style: Theme.of(ctx).textTheme.labelMedium),
          for (final p in parts) Row(children: [Expanded(child: Text('${p['name']}')), Ltr(qtyText(p['qty'] as double))]),
          Row(children: [
            Expanded(child: TextField(key: const Key('part-name'), controller: part, decoration: const InputDecoration(labelText: 'القطعة'), onChanged: (_) => set(() {}))),
            const SizedBox(width: 8),
            SizedBox(width: 70, child: TextField(key: const Key('part-qty'), controller: qty, keyboardType: const TextInputType.numberWithOptions(decimal: true), textDirection: TextDirection.ltr,
                decoration: const InputDecoration(labelText: 'الكمية'), onChanged: (_) => set(() {}))),
            TextButton(key: const Key('part-add'), onPressed: part.text.trim().isEmpty || parseQty(qty.text) == null ? null : () => set(() {
              parts.add({'name': part.text.trim(), 'qty': parseQty(qty.text)!});
              part.clear();
              qty.text = '1';
            }), child: const Text('إضافة قطعة')),
          ]),
          TextField(key: const Key('signer'), controller: who, decoration: const InputDecoration(labelText: 'اسم العميل المستلم'), onChanged: (_) => set(() {})),
          const SizedBox(height: 12),
          FilledButton(
            key: const Key('visit-save'),
            onPressed: result == null || work.text.trim().isEmpty || who.text.trim().isEmpty ? null
                : () => Navigator.pop(ctx, (result: result!, work: work.text.trim(), signer: who.text.trim(), parts: parts)),
            child: const Text('تأكيد انتهاء الزيارة'),
          ),
        ])),
      )),
    );
  }

  /// Odometer (required) and fuel in eighths, for taking or bringing back the vehicle.
  Future<({int km, int? fuel, String? receiver})?> _odometer(BuildContext context, String title, String confirm, {bool fuel = true, bool receiver = false}) async {
    final withFuel = fuel;
    final odo = TextEditingController(), who = TextEditingController();
    int? level;
    return showModalBottomSheet<({int km, int? fuel, String? receiver})>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(builder: (ctx, set) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(title, style: Theme.of(ctx).textTheme.titleLarge),
          const SizedBox(height: 8),
          TextField(key: const Key('odometer'), controller: odo, autofocus: true, keyboardType: TextInputType.number, textDirection: TextDirection.ltr,
              decoration: const InputDecoration(labelText: 'قراءة العدّاد (كم)'), onChanged: (_) => set(() {})),
          if (withFuel) ...[
            const SizedBox(height: 12),
            Text('الوقود', style: Theme.of(ctx).textTheme.labelMedium),
            Wrap(spacing: 6, children: [
              for (final n in [0, 2, 4, 6, 8]) ChoiceChip(key: Key('fuel-$n'), label: Text(fuelLabel(n)), selected: level == n, onSelected: (v) => set(() => level = v ? n : null)),
            ]),
          ],
          if (receiver) TextField(key: const Key('received-by'), controller: who, decoration: const InputDecoration(labelText: 'اسم المستلم'), onChanged: (_) => set(() {})),
          const SizedBox(height: 12),
          FilledButton(
            key: const Key('odometer-save'),
            onPressed: int.tryParse(odo.text.trim()) == null || (receiver && who.text.trim().isEmpty) ? null
                : () => Navigator.pop(ctx, (km: int.parse(odo.text.trim()), fuel: level, receiver: receiver ? who.text.trim() : null)),
            child: Text(confirm),
          ),
        ]),
      )),
    );
  }

  Future<void> _fail(BuildContext context) async {
    final s = AppScope.of(context);
    String? reason;
    final note = TextEditingController();
    final go = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(builder: (ctx, set) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
        child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(task.isStaffing ? 'سبب المغادرة المبكرة' : 'سبب تعذّر التنفيذ', style: Theme.of(ctx).textTheme.titleLarge),
          const SizedBox(height: 8),
          if (failReasonsFor(task) case final reasons?)
            RadioGroup<String>(
              groupValue: reason,
              onChanged: (v) => set(() => reason = v),
              child: Column(children: [for (final e in reasons.entries) RadioListTile<String>(value: e.key, title: Text(e.value), dense: true)]),
            ),
          TextField(controller: note, maxLength: 500, decoration: InputDecoration(labelText: failReasonsFor(task) != null ? 'ملاحظة (اختياري)' : 'السبب')),
          FilledButton(
            onPressed: () => (reason != null || note.text.trim().isNotEmpty) ? Navigator.pop(ctx, true) : null,
            style: FilledButton.styleFrom(backgroundColor: Theme.of(ctx).colorScheme.error),
            child: const Text('تأكيد'),
          ),
        ])),
      )),
    );
    if (go != true) return;
    if (task.isStop) {
      final err = await s.stopClosed(task.id, reason ?? 'other', note: note.text.trim().isEmpty ? null : note.text.trim());
      if (!context.mounted) return;
      if (err != null) return toast(context, err, error: true);
      toast(context, 'سُجّل تعذّر التوقف');
      return Navigator.of(context).pop();
    }
    await s.setStatus(task.id, 'failed', reasonCode: reason, note: note.text.trim().isEmpty ? null : note.text.trim());
    if (context.mounted) toast(context, task.isDelivery ? 'سُجّل التعذّر. أعد الشحنة للمرسل ثم سجّل الإرجاع' : 'سُجّل التعذّر');
  }
}

/// School trip: the stops with their times and, under each, the students to mark boarded, absent or dropped. A child
/// going home who is handed over asks for the adult's name. The count on top shows who is still on the bus.
class _SchoolCard extends StatelessWidget {
  const _SchoolCard({required this.t});
  final DriverTask t;

  Future<void> _drop(BuildContext context, Student x) async {
    final s = AppScope.of(context);
    if (t.toSchool || !x.handover) return s.markStudent(t.id, x.id, 'dropped');
    final ctl = TextEditingController(text: x.guardianName ?? '');
    final name = await showDialog<String>(context: context, builder: (ctx) => AlertDialog(
      title: Text('تسليم ${x.name}'),
      content: TextField(key: const Key('received-by'), controller: ctl, autofocus: true, decoration: const InputDecoration(labelText: 'اسم من استلم الطفل')),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('إلغاء')),
        FilledButton(key: const Key('handover-ok'), onPressed: () => Navigator.pop(ctx, ctl.text.trim()), child: const Text('تم التسليم')),
      ],
    ));
    if (name == null || name.isEmpty) return;
    await s.markStudent(t.id, x.id, 'dropped', receivedBy: name);
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final text = Theme.of(context).textTheme;
    final scheme = Theme.of(context).colorScheme;
    final stops = t.shuttleStops;
    final kids = t.students;
    final open = ['accepted', 'in_progress'].contains(t.status);
    int n(String st) => kids.where((x) => x.state == st).length;
    final onBoard = n('on_board');
    return Card(key: const Key('school-card'), child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text('${t.toSchool ? 'نقل مدرسي: إلى المدرسة' : 'نقل مدرسي: إلى البيوت'} · ${t.attributes['route_code'] ?? ''}${t.isAttendant ? ' · المشرفة' : ''}', style: text.labelMedium),
      Text('${t.attributes['school_name'] ?? ''}', style: text.titleLarge),
      Text('${t.attributes['route_name'] ?? ''}'),
      const SizedBox(height: 6),
      Text('في الحافلة $onBoard · نزل ${n('dropped')} · غائب ${n('absent') + n('excused')} · لم يُسجَّل ${n('waiting')}',
          key: const Key('school-count'), style: TextStyle(fontWeight: FontWeight.bold, color: onBoard > 0 && t.status == 'in_progress' ? scheme.primary : null)),
      if (!open && t.status == 'assigned') const Padding(padding: EdgeInsets.only(top: 4), child: Text('اقبل الرحلة لتسجيل صعود الطلاب')),
      for (final (i, st) in stops.indexed) ...[
        const Divider(),
        Row(children: [
          Ltr(st.time, style: const TextStyle(fontWeight: FontWeight.bold)),
          const SizedBox(width: 8),
          Expanded(child: Text(st.area != null ? '${st.name} · ${st.area}' : st.name, style: text.titleMedium)),
        ]),
        for (final x in kids.where((x) => x.stopSeq == i + 1))
          Padding(padding: const EdgeInsets.symmetric(vertical: 2), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Row(children: [
              Icon(switch (x.state) { 'on_board' => Icons.directions_bus, 'dropped' => Icons.check_circle, 'absent' || 'excused' => Icons.cancel_outlined, _ => Icons.radio_button_unchecked },
                  size: 20, color: switch (x.state) { 'on_board' => scheme.primary, 'dropped' => Colors.green, 'absent' || 'excused' => scheme.error, _ => null }),
              const SizedBox(width: 6),
              Expanded(child: Text('${x.name}${x.grade != null ? ' · ${x.grade}' : ''}${x.handover ? ' · يُسلَّم' : ''}${x.excused && x.event == null ? ' · بلّغ بالغياب' : ''}')),
              if (open && x.state != 'on_board' && x.state != 'dropped') ...[
                Semantics(button: true, label: 'صعد ${x.name}', excludeSemantics: true, child: TextButton(onPressed: () => s.markStudent(t.id, x.id, 'boarded'), child: const Text('صعد'))),
                if (x.state != 'absent') Semantics(button: true, label: 'غائب ${x.name}', excludeSemantics: true, child: TextButton(onPressed: () => s.markStudent(t.id, x.id, 'absent'), child: const Text('غائب'))),
              ],
              if (open && x.state == 'on_board')
                Semantics(button: true, label: 'نزل ${x.name}', excludeSemantics: true, child: TextButton(onPressed: () => _drop(context, x), child: const Text('نزل'))),
            ]),
            if (x.note != null) Padding(padding: const EdgeInsetsDirectional.only(start: 26), child: Text(x.note!, style: TextStyle(color: scheme.error))),
            if (x.receivedBy != null) Padding(padding: const EdgeInsetsDirectional.only(start: 26), child: Text('استلمه: ${x.receivedBy}')),
            if (x.guardianPhone != null && x.state != 'dropped')
              Padding(padding: const EdgeInsetsDirectional.only(start: 26), child: Row(children: [Text('ولي الأمر${x.guardianName != null ? ' (${x.guardianName})' : ''}: '), Ltr(x.guardianPhone!)])),
          ])),
      ],
    ])));
  }
}

/// Staff transport trip: the stops with their times and, under each, the riders to mark boarded or absent.
class _ShuttleCard extends StatelessWidget {
  const _ShuttleCard({required this.t});
  final DriverTask t;

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final text = Theme.of(context).textTheme;
    final scheme = Theme.of(context).colorScheme;
    final stops = t.shuttleStops;
    final riders = t.riders;
    final open = ['accepted', 'in_progress'].contains(t.status);
    final absent = riders.where((r) => r.event == 'no_show').length;
    return Card(key: const Key('shuttle-card'), child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text('${t.toWork ? 'نقل موظفين إلى العمل' : 'نقل موظفين من العمل'} · ${t.attributes['route_code'] ?? ''}', style: text.labelMedium),
      Text('${t.attributes['route_name'] ?? ''}', style: text.titleLarge),
      if (t.attributes['customer_name'] != null) Text('${t.attributes['customer_name']}'),
      const SizedBox(height: 6),
      Text('صعد ${t.boardedCount} من ${riders.length}${absent > 0 ? ' · غائب $absent' : ''}${t.capacity != null ? ' · المقاعد ${t.capacity}' : ''}',
          key: const Key('board-count'), style: const TextStyle(fontWeight: FontWeight.bold)),
      if (!open && t.status == 'assigned') const Padding(padding: EdgeInsets.only(top: 4), child: Text('اقبل الرحلة لتسجيل صعود الركاب')),
      for (final (i, st) in stops.indexed) ...[
        const Divider(),
        Row(children: [
          Ltr(st.time, style: const TextStyle(fontWeight: FontWeight.bold)),
          const SizedBox(width: 8),
          Expanded(child: Text(st.area != null ? '${st.name} · ${st.area}' : st.name, style: text.titleMedium)),
        ]),
        for (final r in riders.where((r) => r.stopSeq == i + 1))
          Padding(padding: const EdgeInsets.symmetric(vertical: 2), child: Row(children: [
            Icon(r.event == 'boarded' ? Icons.check_circle : r.event == 'no_show' ? Icons.cancel_outlined : Icons.radio_button_unchecked,
                size: 20, color: r.event == 'boarded' ? Colors.green : r.event == 'no_show' ? scheme.error : null),
            const SizedBox(width: 6),
            Expanded(child: Text(r.staffNo != null ? '${r.name} (${r.staffNo})' : r.name)),
            if (open) ...[
              Semantics(button: true, label: 'صعد ${r.name}', excludeSemantics: true, child: TextButton(
                  onPressed: r.event == 'boarded' ? null : () => s.markRider(t.id, r.id, 'boarded'), child: const Text('صعد'))),
              Semantics(button: true, label: 'غائب ${r.name}', excludeSemantics: true, child: TextButton(
                  onPressed: r.event == 'no_show' ? null : () => s.markRider(t.id, r.id, 'no_show'), child: const Text('غائب'))),
            ],
          ])),
      ],
    ])));
  }
}
