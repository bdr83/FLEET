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
        Card(child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(t.isConcrete || t.isStaffing ? 'الموقع' : t.isInternal ? 'الوجهة' : t.isFreight ? 'التفريغ في' : 'العنوان', style: text.labelMedium),
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
      case TaskAction.complete: await s.setStatus(task.id, 'completed');
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

  /// Odometer (required) and fuel in eighths, for taking or bringing back the vehicle.
  Future<({int km, int? fuel})?> _odometer(BuildContext context, String title, String confirm, {bool fuel = true}) async {
    final withFuel = fuel;
    final odo = TextEditingController();
    int? level;
    return showModalBottomSheet<({int km, int? fuel})>(
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
          const SizedBox(height: 12),
          FilledButton(
            key: const Key('odometer-save'),
            onPressed: int.tryParse(odo.text.trim()) == null ? null : () => Navigator.pop(ctx, (km: int.parse(odo.text.trim()), fuel: level)),
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
