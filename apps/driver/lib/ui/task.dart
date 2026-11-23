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
        if (t.isTaxi) ...[
          Card(key: const Key('taxi-card'), child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('${taxiClassLabels[t.attributes['class']] ?? ''} · ${t.attributes['booking_ref'] ?? ''}${t.attributes['flight_no'] != null ? ' · رحلة ${t.attributes['flight_no']}' : ''}', style: text.labelMedium),
            Text(t.passengerName ?? '', style: text.titleLarge),
            if (t.passengerPhone != null) Row(children: [const Text('الهاتف: '), Ltr(t.passengerPhone!)]),
            if ((t.attributes['pax'] as num? ?? 1) > 1) Text('عدد الركاب: ${t.attributes['pax']}'),
            Text('من: ${t.attributes['pickup_line'] ?? '—'}'),
            Text('إلى: ${t.attributes['dropoff_line'] ?? 'يحددها الراكب'}'),
            if (t.fixedFare != null) Row(children: [const Text('الأجرة: '), Ltr('${t.fixedFare} د.ك', style: text.titleMedium), const Text(' (ثابتة)')]),
            if (t.onAccount) Text('على حساب ${t.attributes['customer_name'] ?? 'الشركة'}'),
            if (t.attributes['notes'] != null) Text('${t.attributes['notes']}'),
          ]))),
          const SizedBox(height: 12),
        ],
        if (t.isUtilities) ...[
          Card(key: const Key('utilities-card'), child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('${t.attributes['job_ref'] ?? ''} · ${utNetworkLabels[t.attributes['network']] ?? ''} · ${utTypeLabels[t.attributes['job_type']] ?? ''}', style: text.labelMedium),
            Text('${t.attributes['description'] ?? ''}', style: text.titleLarge),
            Text('الأولوية: ${utPriorityLabels[t.attributes['priority']] ?? '—'}', key: const Key('ut-priority'),
                style: t.attributes['priority'] == 'emergency' ? text.titleSmall?.copyWith(color: Theme.of(context).colorScheme.error) : null),
            if (t.attributes['due_at'] != null) Text('الوصول قبل: ${_stopAt(t.attributes['due_at'] as String)}'),
            if (t.attributes['asset_ref'] != null) Text('الأصل: ${t.attributes['asset_ref']}'),
            if ((t.attributes['affected'] as num? ?? 0) > 0) Text('المشتركون المتأثرون: ${t.attributes['affected']}'),
            if (t.attributes['needs_permit'] == true)
              Text(t.attributes['permit_no'] != null ? 'تصريح الحفر: ${t.attributes['permit_no']} حتى ${t.attributes['permit_expires']}' : '⚠ أعمال حفر: لا تصريح بعد',
                  key: const Key('ut-permit'), style: t.attributes['permit_no'] == null ? text.titleSmall?.copyWith(color: Theme.of(context).colorScheme.error) : null),
            if (t.attributes['customer_name'] != null) Text('${t.attributes['customer_name']}'),
          ]))),
          const SizedBox(height: 12),
        ],
        if (t.isPest) ...[
          Card(key: const Key('pest-card'), child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('${t.attributes['job_ref'] ?? ''} · ${pestPremisesLabels[t.attributes['premises']] ?? ''} · ${pestServiceLabels[t.attributes['service']] ?? ''}', style: text.labelMedium),
            Text('${t.attributes['customer_name'] ?? ''}', style: text.titleLarge),
            Text('الآفات: ${[for (final p in (t.attributes['pests'] as List? ?? const [])) pestLabels[p] ?? p].join('، ')}'),
            if (t.attributes['in_warranty'] == true) Text('إعادة زيارة ضمن الضمان (بلا رسوم)', style: text.titleSmall?.copyWith(color: Theme.of(context).colorScheme.error)),
            if (t.attributes['previous'] != null) Text('الزيارة السابقة: ${t.attributes['previous']}'),
            if (t.attributes['notes'] != null) Text('${t.attributes['notes']}', style: TextStyle(color: Theme.of(context).colorScheme.primary)),
            if (t.attributes['contact_phone'] != null) Ltr('${t.attributes['contact_phone']}'),
          ]))),
          const SizedBox(height: 12),
        ],
        if (t.isLandscape) ...[
          Card(key: const Key('landscape-card'), child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('${t.attributes['site_code'] ?? ''}${t.attributes['extra'] == true ? ' · زيارة إضافية' : ''}', style: text.labelMedium),
            Text('${t.attributes['site_name'] ?? ''}', style: text.titleLarge),
            if (t.attributes['customer_name'] != null) Text('${t.attributes['customer_name']}'),
            Text('الخدمات: ${[for (final x in (t.attributes['services'] as List? ?? const [])) landscapeServiceLabels[x] ?? x].join('، ')}'),
            Text('الطاقم: ${t.attributes['crew_size'] ?? '—'} عمال${t.attributes['area_m2'] != null ? ' · ${t.attributes['area_m2']} م²' : ''}${t.attributes['irrigation'] == true ? ' · فيها شبكة ري' : ''}'),
            if (t.attributes['instructions'] != null) Text('${t.attributes['instructions']}', style: TextStyle(color: Theme.of(context).colorScheme.primary)),
            if (t.attributes['contact_phone'] != null) Ltr('${t.attributes['contact_phone']}'),
          ]))),
          const SizedBox(height: 12),
        ],
        if (t.isOilgas) ...[
          Card(key: const Key('oilgas-card'), child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('${t.attributes['journey_ref'] ?? ''} · ${t.attributes['site_code'] ?? ''}', style: text.labelMedium),
            Text('${t.attributes['site_name'] ?? ''}', style: text.titleLarge),
            if (t.attributes['field'] != null) Text('الحقل: ${t.attributes['field']}'),
            Text('من: ${t.attributes['from_place'] ?? '—'}'),
            if (t.attributes['eta_at'] != null) Text('الوصول المتوقع: ${_stopAt(t.attributes['eta_at'] as String)}'),
            if ((t.attributes['passengers'] as num? ?? 0) > 0) Text('الركاب: ${t.attributes['passengers']}'),
            if (t.attributes['cargo'] != null) Text('الحمولة: ${t.attributes['cargo']}'),
            if (t.attributes['hazmat'] == true) Text('⚠ حمولة خطرة', style: text.titleSmall?.copyWith(color: Theme.of(context).colorScheme.error)),
            if (t.attributes['h2s_zone'] == true) const Text('منطقة H2S: جهاز الكشف إلزامي'),
            Text('بلاغ كل ${t.attributes['checkin_min'] ?? 60} دقيقة'),
            if (t.attributes['customer_name'] != null) Text('${t.attributes['customer_name']}'),
            if (t.attributes['notes'] != null) Text('${t.attributes['notes']}'),
          ]))),
          const SizedBox(height: 12),
        ],
        if (t.isTour) ...[
          Card(key: const Key('tour-card'), child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('${t.attributes['trip_ref'] ?? ''} · حافلة ${t.attributes['bus_seq'] ?? ''}${t.attributes['cross_border'] == true ? ' · عبر الحدود' : ''}', style: text.labelMedium),
            Text('${t.attributes['group_name'] ?? ''}', style: text.titleLarge),
            if (t.attributes['customer_name'] != null) Text('${t.attributes['customer_name']}'),
            Text('الركاب: ${t.attributes['pax'] ?? '—'}${t.attributes['seats'] != null ? ' · مقاعد الحافلة: ${t.attributes['seats']}' : ''}'),
            Text('التجمع: ${t.attributes['pickup'] ?? '—'}'),
            Text('الوجهة: ${t.attributes['destination'] ?? '—'}'),
            if (t.attributes['contact_name'] != null || t.attributes['contact_phone'] != null)
              Row(children: [Text('المسؤول: ${t.attributes['contact_name'] ?? ''} '), if (t.attributes['contact_phone'] != null) Ltr('${t.attributes['contact_phone']}')]),
            if (t.itinerary.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text('البرنامج', style: text.titleSmall),
              for (final st in t.itinerary) Text('• ${st['place']}${st['at'] != null ? ' (${_stopAt(st['at'] as String)})' : ''}${st['note'] != null ? ' · ${st['note']}' : ''}'),
            ],
            if (t.attributes['notes'] != null) Text('${t.attributes['notes']}'),
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
        if (t.isSecurity) ...[
          _PatrolCard(t: t),
          const SizedBox(height: 12),
        ],
        if (t.isWaste) ...[
          _WasteCard(t: t),
          const SizedBox(height: 12),
        ],
        if (t.isEquipment && t.liftList.isNotEmpty) ...[
          _LiftsCard(t: t),
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
        final block = task.isSchool ? task.schoolFinishBlock : task.isWaste ? task.wasteFinishBlock : task.isSecurity ? task.securityFinishBlock : null;
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
      case TaskAction.txArrived: await s.milestone(task.id, 'tx_arrived');
      case TaskAction.txPicked: await s.milestone(task.id, 'tx_picked');
      case TaskAction.txDropped:
        final r = await _taxiForm(context);
        if (r == null) return;
        final err = await s.taxiDropped(task.id, km: r.km, payment: r.payment);
        if (!context.mounted) return;
        if (err != null) return toast(context, err, error: true);
        toast(context, s.offline ? 'سُجّل المشوار وسيُرسل عند عودة الاتصال' : 'انتهى المشوار');
        Navigator.of(context).pop();
      case TaskAction.utArrived:
      case TaskAction.utReinstated:
        final err = await s.utilitiesStage(task.id, action == TaskAction.utArrived ? 'ut_arrived' : 'ut_reinstated');
        if (err != null && context.mounted) toast(context, err, error: true);
      case TaskAction.utIsolate:
        final checks = await _utilitiesChecksForm(context);
        if (checks == null) return;
        final err = await s.utilitiesStage(task.id, 'ut_isolated', checks: checks);
        if (err != null && context.mounted) toast(context, err, error: true);
      case TaskAction.utRestored:
        final r = await _utilitiesResultForm(context);
        if (r == null) return;
        final err = await s.utilitiesStage(task.id, 'ut_restored', result: r.result, note: r.note);
        if (err != null && context.mounted) toast(context, err, error: true);
      case TaskAction.pcArrived:
        final err = await s.pestStage(task.id, 'pc_arrived');
        if (err != null && context.mounted) toast(context, err, error: true);
      case TaskAction.pcTreated:
        final r = await _pestForm(context);
        if (r == null) return;
        final err = await s.pestStage(task.id, 'pc_treated', applications: r.apps, infestation: r.infestation, receivedBy: r.receivedBy, note: r.note);
        if (!context.mounted) return;
        if (err != null) return toast(context, err, error: true);
        final hours = [for (final a in r.apps) for (final p in (task.attributes['products'] as List? ?? const [])) if (p is Map && p['id'] == a['product_id']) (p['reentry_hours'] as num?)?.toInt() ?? 0];
        final h = hours.isEmpty ? 0 : hours.reduce((x, y) => x > y ? x : y);
        toast(context, h > 0 ? 'سُجّل العلاج. أبلغ العميل: لا دخول قبل $h ساعات' : 'سُجّل العلاج');
      case TaskAction.lsArrived:
        final err = await s.landscapeStage(task.id, 'ls_arrived');
        if (err != null && context.mounted) toast(context, err, error: true);
      case TaskAction.lsDone:
        final r = await _landscapeForm(context);
        if (r == null) return;
        final err = await s.landscapeStage(task.id, 'ls_done', services: r.services, irrigation: r.irrigation, bags: r.bags, receivedBy: r.receivedBy, note: r.note);
        if (!context.mounted) return;
        if (err != null) return toast(context, err, error: true);
        toast(context, r.irrigation != null && r.irrigation != 'ok' && r.irrigation != 'not_checked' ? 'سُجّل العمل، وأُبلغ المكتب بعطل الري' : 'سُجّل العمل');
      case TaskAction.ogInspect:
        final checks = await _oilgasForm(context);
        if (checks == null) return;
        final err = await s.oilgasStage(task.id, 'og_inspected', checks: checks);
        if (err != null && context.mounted) toast(context, err, error: true);
      case TaskAction.ogDepart:
      case TaskAction.ogCheckin:
      case TaskAction.ogArrived:
        final code = {TaskAction.ogDepart: 'og_departed', TaskAction.ogCheckin: 'og_checkin', TaskAction.ogArrived: 'og_arrived'}[action]!;
        final err = await s.oilgasStage(task.id, code);
        if (!context.mounted) return;
        if (err != null) return toast(context, err, error: true);
        if (action == TaskAction.ogCheckin) toast(context, s.offline ? 'سُجّل البلاغ وسيُرسل عند عودة الاتصال' : 'وصل البلاغ لمدير الرحلات');
      case TaskAction.trBoarded:
      case TaskAction.trReturned:
        final out = action == TaskAction.trBoarded;
        final r = await _tourForm(context, out: out);
        if (r == null) return;
        final err = out ? await s.tourBoarded(task.id, headcount: r.heads, odometer: r.odo) : await s.tourReturned(task.id, headcount: r.heads, odometer: r.odo, note: r.note);
        if (!context.mounted) return;
        if (err != null) return toast(context, err, error: true);
        if (!out) {
          toast(context, s.offline ? 'سُجّلت العودة وسترسل عند عودة الاتصال' : 'سُجّلت العودة وانتهت الرحلة');
          Navigator.of(context).pop();
        }
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
        if (end && task.liftsOpen) return toast(context, rejectReasons['lifts_open']!, error: true);
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

  /// Taxi drop: the trip km (not needed for a fixed fare) and the payment; shows the fare to collect.
  Future<({double? km, String payment})?> _taxiForm(BuildContext context) {
    final km = TextEditingController();
    String? pay = task.onAccount ? 'account' : 'cash';
    bool ok() => pay != null && (task.fixedFare != null || parseKm(km.text) != null);
    return showModalBottomSheet<({double? km, String payment})>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(builder: (ctx, set) {
        final k = parseKm(km.text);
        final fare = k == null && task.fixedFare == null ? null : task.fareFor(k ?? 0, 0);
        return Padding(
          padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('نهاية المشوار', style: Theme.of(ctx).textTheme.titleLarge),
            const SizedBox(height: 8),
            TextField(key: const Key('trip-km'), controller: km, autofocus: task.fixedFare == null, keyboardType: const TextInputType.numberWithOptions(decimal: true), textDirection: TextDirection.ltr,
                decoration: InputDecoration(labelText: task.fixedFare == null ? 'كيلومترات المشوار' : 'كيلومترات المشوار (اختياري)'), onChanged: (_) => set(() {})),
            RadioGroup<String>(
              groupValue: pay,
              onChanged: (v) => set(() => pay = v),
              child: Column(children: [
                for (final e in paymentLabels.entries)
                  if (e.key != 'account' || task.onAccount) RadioListTile<String>(value: e.key, title: Text(e.value), dense: true),
              ]),
            ),
            if (fare != null) Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Row(children: [
              const Text('الأجرة: '), Ltr('$fare د.ك', key: const Key('taxi-fare'), style: Theme.of(ctx).textTheme.headlineSmall),
              if (task.fixedFare == null) const Text(' تقريبًا، بدون الانتظار'),
            ])),
            const SizedBox(height: 8),
            FilledButton(
              key: const Key('taxi-save'),
              onPressed: ok() ? () => Navigator.pop(ctx, (km: parseKm(km.text), payment: pay!)) : null,
              child: const Text('تأكيد'),
            ),
          ]),
        );
      }),
    );
  }

  /// Utilities safety checklist before work: every item must be ticked (the API refuses otherwise); the permit item only when digging.
  Future<Map<String, bool>?> _utilitiesChecksForm(BuildContext context) {
    final items = utilitiesChecks.keys.where((k) => k != 'permit_on_site' || task.attributes['needs_permit'] == true).toList();
    final v = {for (final k in items) k: false};
    return showModalBottomSheet<Map<String, bool>>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(builder: (ctx, set) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('قائمة السلامة قبل العمل', style: Theme.of(ctx).textTheme.titleLarge),
          for (final k in items)
            CheckboxListTile(key: Key('ut-check-$k'), value: v[k], title: Text(utilitiesChecks[k]!), onChanged: (x) => set(() => v[k] = x ?? false)),
          const SizedBox(height: 8),
          FilledButton(key: const Key('ut-checks-save'), onPressed: v.values.every((x) => x) ? () => Navigator.pop(ctx, Map<String, bool>.from(v)) : null,
              child: const Text('تأكيد العزل')),
        ]),
      )),
    );
  }

  /// Utilities repair: the result and a note.
  Future<({String result, String? note})?> _utilitiesResultForm(BuildContext context) {
    String? result;
    final n = TextEditingController();
    return showModalBottomSheet<({String result, String? note})>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(builder: (ctx, set) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('نتيجة الإصلاح', style: Theme.of(ctx).textTheme.titleLarge),
          for (final e in utilitiesResults.entries)
            ListTile(key: Key('ut-result-${e.key}'), title: Text(e.value), selected: result == e.key,
                leading: Icon(result == e.key ? Icons.radio_button_checked : Icons.radio_button_unchecked), onTap: () => set(() => result = e.key)),
          TextField(key: const Key('ut-note'), controller: n, maxLength: 500, decoration: const InputDecoration(labelText: 'ملاحظة (ما تم)')),
          const SizedBox(height: 8),
          FilledButton(key: const Key('ut-result-save'), onPressed: result == null ? null : () => Navigator.pop(ctx, (result: result!, note: n.text.trim().isEmpty ? null : n.text.trim())),
              child: const Text('تأكيد')),
        ]),
      )),
    );
  }

  /// Pest treatment: the quantity of each product used (empty = not used), the place, the infestation level, the receiver and a note.
  Future<({List<Map<String, dynamic>> apps, String infestation, String receivedBy, String? note})?> _pestForm(BuildContext context) {
    final products = [for (final p in (task.attributes['products'] as List? ?? const [])) if (p is Map) Map<String, dynamic>.from(p)];
    final qty = {for (final p in products) p['id'] as String: TextEditingController()};
    final where = TextEditingController(), by = TextEditingController(), note = TextEditingController();
    String? level;
    double? q(String id) {
      final x = double.tryParse(qty[id]!.text.trim().replaceAll('٫', '.').replaceAll(',', '.'));
      return x != null && x > 0 && x <= 100000 ? x : null;
    }
    return showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(builder: (ctx, set) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
        child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('تسجيل العلاج', style: Theme.of(ctx).textTheme.titleLarge),
          const Text('اكتب كمية كل مبيد استخدمته، واترك الباقي فارغًا.'),
          for (final p in products)
            TextField(key: Key('qty-${p['id']}'), controller: qty[p['id']], keyboardType: const TextInputType.numberWithOptions(decimal: true), onChanged: (_) => set(() {}),
                decoration: InputDecoration(labelText: '${p['name']} (${pestUnitLabels[p['unit']] ?? p['unit']})')),
          TextField(key: const Key('pc-where'), controller: where, maxLength: 120, decoration: const InputDecoration(labelText: 'أماكن العلاج (المطبخ، المخزن...)')),
          const SizedBox(height: 8),
          const Text('مستوى الإصابة'),
          Wrap(spacing: 6, children: [for (final e in infestationLabels.entries) ChoiceChip(label: Text(e.value), selected: level == e.key, onSelected: (_) => set(() => level = e.key))]),
          TextField(key: const Key('pc-by'), controller: by, maxLength: 120, onChanged: (_) => set(() {}), decoration: const InputDecoration(labelText: 'اسم المستلم')),
          TextField(key: const Key('pc-note'), controller: note, maxLength: 500, decoration: const InputDecoration(labelText: 'ملاحظة للعميل والمكتب')),
          FilledButton(key: const Key('pc-save'), onPressed: level == null || by.text.trim().isEmpty ? null : () => Navigator.pop(ctx, (
                apps: [for (final p in products) if (q(p['id'] as String) != null) {'product_id': p['id'], 'qty': q(p['id'] as String), if (where.text.trim().isNotEmpty) 'location': where.text.trim()}],
                infestation: level!, receivedBy: by.text.trim(), note: note.text.trim().isEmpty ? null : note.text.trim())),
              child: const Text('تأكيد العلاج')),
        ])),
      )),
    );
  }

  /// Garden visit done: the services carried out (the planned ones ticked to start with, marked with an icon), the irrigation state when the garden
  /// has a network, the green waste bags, the receiver and a note (needed when a planned service was left undone).
  Future<({List<String> services, String? irrigation, int bags, String? receivedBy, String? note})?> _landscapeForm(BuildContext context) {
    final planned = [for (final x in (task.attributes['services'] as List? ?? const [])) '$x'];
    final hasNet = task.attributes['irrigation'] == true;
    final done = {...planned};
    final bags = TextEditingController(), by = TextEditingController(), note = TextEditingController();
    String? net;
    bool undone() => planned.any((x) => !done.contains(x));
    bool ok() => done.isNotEmpty && (!hasNet || net != null) && parseCount(bags.text, 500) != null && (!undone() || note.text.trim().isNotEmpty);
    return showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(builder: (ctx, set) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
        child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('العمل المنجز', style: Theme.of(ctx).textTheme.titleLarge),
          Wrap(spacing: 6, runSpacing: 4, children: [
            for (final e in landscapeServiceLabels.entries)
              FilterChip(key: Key('svc-${e.key}'), label: Text(e.value), selected: done.contains(e.key),
                  avatar: planned.contains(e.key) ? const Icon(Icons.event_note, size: 16) : null,
                  onSelected: (v) => set(() => v ? done.add(e.key) : done.remove(e.key))),
          ]),
          if (hasNet) ...[
            const SizedBox(height: 8),
            const Text('شبكة الري'),
            Wrap(spacing: 6, children: [for (final e in irrigationLabels.entries) ChoiceChip(key: Key('net-${e.key}'), label: Text(e.value), selected: net == e.key, onSelected: (_) => set(() => net = e.key))]),
          ],
          TextField(key: const Key('ls-bags'), controller: bags, keyboardType: TextInputType.number, onChanged: (_) => set(() {}), decoration: const InputDecoration(labelText: 'أكياس المخلفات الخضراء')),
          TextField(key: const Key('ls-by'), controller: by, maxLength: 120, decoration: const InputDecoration(labelText: 'اسم المستلم (اختياري)')),
          TextField(key: const Key('ls-note'), controller: note, maxLength: 500, onChanged: (_) => set(() {}),
              decoration: InputDecoration(labelText: undone() ? 'سبب عدم تنفيذ: ${[for (final x in planned) if (!done.contains(x)) landscapeServiceLabels[x] ?? x].join('، ')}' : 'ملاحظة للعميل والمكتب')),
          FilledButton(key: const Key('ls-save'), onPressed: !ok() ? null : () => Navigator.pop(ctx, (
                services: [for (final k in landscapeServiceLabels.keys) if (done.contains(k)) k], irrigation: net, bags: parseCount(bags.text, 500)!,
                receivedBy: by.text.trim().isEmpty ? null : by.text.trim(), note: note.text.trim().isEmpty ? null : note.text.trim())),
              child: const Text('تأكيد العمل')),
        ])),
      )),
    );
  }

  /// Oilfield pre-trip inspection: every item ticked passes; an unticked item is sent as failed (kept for the office).
  Future<Map<String, bool>?> _oilgasForm(BuildContext context) {
    final items = oilgasChecks.keys.where((k) => k != 'h2s_monitor' || task.attributes['h2s_zone'] == true).toList();
    final v = {for (final k in items) k: false};
    return showModalBottomSheet<Map<String, bool>>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(builder: (ctx, set) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('فحص المركبة قبل الانطلاق', style: Theme.of(ctx).textTheme.titleLarge),
          for (final k in items)
            CheckboxListTile(key: Key('check-$k'), value: v[k], title: Text(oilgasChecks[k]!), onChanged: (x) => set(() => v[k] = x ?? false)),
          const SizedBox(height: 8),
          FilledButton(key: const Key('og-save'), onPressed: () => Navigator.pop(ctx, Map<String, bool>.from(v)),
              child: Text(v.values.every((x) => x) ? 'تأكيد الفحص' : 'إرسال الفحص (فيه خلل)')),
        ]),
      )),
    );
  }

  /// Tour bus: the head count and the odometer on boarding, and on return with a note (needed when fewer came back).
  Future<({int heads, int odo, String? note})?> _tourForm(BuildContext context, {required bool out}) {
    final h = TextEditingController(), o = TextEditingController(), n = TextEditingController();
    final seats = (task.attributes['seats'] as num?)?.toInt() ?? 200;
    bool ok() => parseCount(h.text, seats) != null && parseCount(o.text, 10000000) != null;
    return showModalBottomSheet<({int heads, int odo, String? note})>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(builder: (ctx, set) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(out ? 'صعود الركاب' : 'العودة', style: Theme.of(ctx).textTheme.titleLarge),
          const SizedBox(height: 8),
          TextField(key: const Key('headcount'), controller: h, autofocus: true, keyboardType: TextInputType.number, textDirection: TextDirection.ltr,
              decoration: InputDecoration(labelText: 'عدد الركاب في الحافلة', helperText: 'المقاعد: $seats',
                  errorText: h.text.trim().isNotEmpty && parseCount(h.text, seats) == null ? 'العدد أكثر من المقاعد أو غير صحيح' : null), onChanged: (_) => set(() {})),
          TextField(key: const Key('tour-odometer'), controller: o, keyboardType: TextInputType.number, textDirection: TextDirection.ltr,
              decoration: const InputDecoration(labelText: 'قراءة العدّاد (كم)'), onChanged: (_) => set(() {})),
          if (!out) TextField(key: const Key('tour-note'), controller: n, maxLength: 500, decoration: const InputDecoration(labelText: 'ملاحظة (إلزامية إن عاد عدد أقل)')),
          const SizedBox(height: 12),
          FilledButton(
            key: const Key('tour-save'),
            onPressed: ok() ? () => Navigator.pop(ctx, (heads: parseCount(h.text, seats)!, odo: parseCount(o.text, 10000000)!, note: n.text.trim().isEmpty ? null : n.text.trim())) : null,
            child: Text(out ? 'تأكيد الصعود والانطلاق' : 'تأكيد العودة'),
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

/// A stop time of the tour itinerary: day/month and the hour, in the phone's time.
String _stopAt(String iso) {
  final d = DateTime.parse(iso).toLocal();
  return '${d.day}/${d.month} ${two(d.hour)}:${two(d.minute)}';
}

/// Crane working day: the lift plans in order, each with its load against the rated capacity. The operator records a lift
/// done with the wind speed read on site, or stops it with the reason. A critical lift not yet approved cannot be done.
class _LiftsCard extends StatelessWidget {
  const _LiftsCard({required this.t});
  final DriverTask t;

  Future<void> _record(BuildContext context, Lift l, bool done) async {
    final s = AppScope.of(context);
    final wind = TextEditingController(), note = TextEditingController();
    final ok = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: Text(done ? 'تنفيذ ${l.ref}' : 'إيقاف ${l.ref}'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(key: const Key('lift-wind'), controller: wind, autofocus: true, keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: InputDecoration(labelText: done ? 'سرعة الرياح الآن (م/ث)' : 'سرعة الرياح (اختياري)', helperText: 'حد الرافعة ${qtyText(l.windLimit)} م/ث')),
        if (!done) TextField(key: const Key('lift-note'), controller: note, decoration: const InputDecoration(labelText: 'سبب الإيقاف')),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('رجوع')),
        FilledButton(key: const Key('lift-ok'), onPressed: () => Navigator.pop(ctx, true), child: Text(done ? 'نُفذت' : 'أوقفت')),
      ],
    ));
    if (ok != true || !context.mounted) return;
    final w = double.tryParse(wind.text.trim().replaceAll(',', '.'));
    if (done && w == null) return toast(context, rejectReasons['wind_required']!, error: true);
    if (done && w! > l.windLimit) return toast(context, rejectReasons['wind_too_high']!, error: true);
    if (!done && note.text.trim().isEmpty) return toast(context, rejectReasons['abort_reason_required']!, error: true);
    final err = await s.markLift(t.id, l.id, done ? 'done' : 'aborted', wind: w, note: done ? null : note.text.trim());
    if (!context.mounted) return;
    if (err != null) return toast(context, err, error: true);
    toast(context, done ? 'سُجّلت الرفعة منفذة' : 'سُجّل إيقاف الرفعة');
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final scheme = Theme.of(context).colorScheme;
    final lifts = t.liftList;
    final open = t.status == 'in_progress';
    return Card(key: const Key('lifts-card'), child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text('خطط الرفع اليوم', style: text.titleMedium),
      Text('مخططة ${lifts.where((l) => l.status == 'planned').length} من ${lifts.length}', key: const Key('lifts-count')),
      if (!open && t.status != 'completed') const Padding(padding: EdgeInsets.only(top: 4), child: Text('ابدأ العمل لتسجيل الرفعات')),
      for (final l in lifts) ...[
        const Divider(),
        Row(children: [
          if (l.time != null) ...[Ltr(l.time!, style: const TextStyle(fontWeight: FontWeight.bold)), const SizedBox(width: 8)],
          Ltr(l.ref, style: text.labelMedium),
          const SizedBox(width: 8),
          Expanded(child: Text(l.description, style: text.titleSmall)),
          Icon(switch (l.status) { 'done' => Icons.check_circle, 'aborted' => Icons.cancel_outlined, _ => Icons.radio_button_unchecked },
              size: 20, color: switch (l.status) { 'done' => Colors.green, 'aborted' => scheme.error, _ => null }),
        ]),
        Row(children: [const Text('الحمولة '), Ltr('${qtyText(l.loadT)} t @ ${qtyText(l.radiusM)} m'), const Text(' · '), Ltr('${qtyText(l.utilization)}%',
            style: TextStyle(fontWeight: FontWeight.bold, color: l.utilization >= 75 ? scheme.error : null)), Text(' من ${qtyText(l.ratedT)} طن')]),
        if (l.critical) Text(l.approved ? 'رفعة حرجة معتمدة' : '⚠ رفعة حرجة لم تُعتمد: لا تنفذها', style: TextStyle(color: l.approved ? null : scheme.error, fontWeight: FontWeight.bold)),
        if (open && l.status == 'planned') Row(mainAxisAlignment: MainAxisAlignment.end, children: [
          Semantics(button: true, label: 'نُفذت ${l.ref}', excludeSemantics: true, child: TextButton(onPressed: l.blocked ? null : () => _record(context, l, true), child: const Text('نُفذت'))),
          Semantics(button: true, label: 'أوقفت ${l.ref}', excludeSemantics: true, child: TextButton(onPressed: () => _record(context, l, false), child: const Text('أوقفت'))),
        ]),
        if (l.status != 'planned') Text(l.status == 'done' ? 'نُفذت' : l.status == 'aborted' ? 'أُوقفت' : 'ملغاة', style: text.bodySmall),
      ],
    ])));
  }
}

/// Waste round: the collection points in order with the customer's bins. The driver marks each point collected (bins
/// emptied, the planned count by default) or missed with a reason, and records each tip at the landfill with the
/// weighbridge ticket and net weight. The round ends when every point is marked and, if anything was collected, a ticket is in.
class _WasteCard extends StatelessWidget {
  const _WasteCard({required this.t});
  final DriverTask t;

  Future<void> _collected(BuildContext context, WastePoint p) async {
    final s = AppScope.of(context);
    final ctl = TextEditingController(text: '${p.binCount}');
    final n = await showDialog<int>(context: context, builder: (ctx) => AlertDialog(
      title: Text('جُمعت: ${p.name}'),
      content: TextField(key: const Key('bins-emptied'), controller: ctl, autofocus: true, keyboardType: TextInputType.number, decoration: InputDecoration(labelText: 'عدد الحاويات المفرّغة', helperText: p.binsText)),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('رجوع')),
        FilledButton(key: const Key('bins-ok'), onPressed: () => Navigator.pop(ctx, parseCount(ctl.text, 200)), child: const Text('تأكيد')),
      ],
    ));
    if (n == null || !context.mounted) return;
    if (n > p.binCount * 2) return toast(context, rejectReasons['bins_invalid']!, error: true);
    await s.markVisit(t.id, p.id, 'collected', bins: n);
  }

  Future<void> _missed(BuildContext context, WastePoint p) async {
    final s = AppScope.of(context);
    final reason = await showDialog<String>(context: context, builder: (ctx) => SimpleDialog(
      title: Text('لم تُجمع: ${p.name}'),
      children: [for (final e in wasteMissReasons.entries) SimpleDialogOption(onPressed: () => Navigator.pop(ctx, e.key), child: Text(e.value))],
    ));
    if (reason == null || !context.mounted) return;
    await s.markVisit(t.id, p.id, 'missed', reason: reason);
  }

  Future<void> _dump(BuildContext context) async {
    final s = AppScope.of(context);
    final ticket = TextEditingController(), net = TextEditingController(), fac = TextEditingController(text: '${t.attributes['facility'] ?? ''}');
    final ok = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: const Text('تفريغ في المردم'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(key: const Key('ticket-no'), controller: ticket, autofocus: true, decoration: const InputDecoration(labelText: 'رقم تذكرة الميزان')),
        TextField(key: const Key('net-kg'), controller: net, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'الوزن الصافي (كغ)')),
        TextField(key: const Key('facility'), controller: fac, decoration: const InputDecoration(labelText: 'المردم')),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('رجوع')),
        FilledButton(key: const Key('dump-ok'), onPressed: () => Navigator.pop(ctx, true), child: const Text('تسجيل التذكرة')),
      ],
    ));
    if (ok != true || !context.mounted) return;
    final kg = double.tryParse(net.text.trim().replaceAll(',', '.'));
    if (ticket.text.trim().isEmpty) return toast(context, rejectReasons['ticket_required']!, error: true);
    if (kg == null || kg <= 0 || kg > 40000) return toast(context, rejectReasons['weight_required']!, error: true);
    final err = await s.addDump(t.id, ticketNo: ticket.text.trim(), netKg: kg, facility: fac.text.trim().isEmpty ? null : fac.text.trim());
    if (!context.mounted) return;
    if (err != null) return toast(context, err, error: true);
    toast(context, 'سُجّلت تذكرة الميزان');
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final scheme = Theme.of(context).colorScheme;
    final pts = t.wastePoints;
    final open = t.status == 'in_progress';
    int n(String? e) => pts.where((p) => p.event == e).length;
    final kg = (t.waste?['net_kg'] as num?)?.toDouble() ?? 0;
    return Card(key: const Key('waste-card'), child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text('جولة جمع · ${t.attributes['route_code'] ?? ''}', style: text.labelMedium),
      Text('${t.attributes['route_name'] ?? ''}', style: text.titleLarge),
      if (t.attributes['facility'] != null) Text('المردم: ${t.attributes['facility']}'),
      const SizedBox(height: 6),
      Text('جُمعت ${n('collected')} · لم تُجمع ${n('missed')} · باقية ${n(null)} · تذاكر ${t.wasteTickets}${kg > 0 ? ' (${qtyText(kg / 1000)} طن)' : ''}',
          key: const Key('waste-count'), style: const TextStyle(fontWeight: FontWeight.bold)),
      if (!open && ['assigned', 'accepted'].contains(t.status)) const Padding(padding: EdgeInsets.only(top: 4), child: Text('ابدأ الجولة لتسجيل النقاط')),
      for (final p in pts) ...[
        const Divider(),
        Row(children: [
          Ltr('${p.seq}', style: const TextStyle(fontWeight: FontWeight.bold)),
          const SizedBox(width: 8),
          Expanded(child: Text(p.area != null ? '${p.name} · ${p.area}' : p.name, style: text.titleSmall)),
          Icon(switch (p.event) { 'collected' => Icons.check_circle, 'missed' => Icons.cancel_outlined, _ => Icons.radio_button_unchecked },
              size: 20, color: switch (p.event) { 'collected' => Colors.green, 'missed' => scheme.error, _ => null }),
        ]),
        Text(p.binsText),
        if (p.customerName != null) Text(p.customerName!, style: text.bodySmall),
        if (p.note != null) Text(p.note!, style: TextStyle(color: scheme.primary)),
        if (p.event == 'collected') Text('حاويات مفرّغة: ${p.binsEmptied ?? 0}'),
        if (p.event == 'missed') Text('لم تُجمع: ${wasteMissReasons[p.reason] ?? p.reason ?? ''}', style: TextStyle(color: scheme.error)),
        if (open) Row(mainAxisAlignment: MainAxisAlignment.end, children: [
          Semantics(button: true, label: 'جُمعت ${p.name}', excludeSemantics: true, child: TextButton(onPressed: () => _collected(context, p), child: const Text('جُمعت'))),
          Semantics(button: true, label: 'لم تُجمع ${p.name}', excludeSemantics: true, child: TextButton(onPressed: () => _missed(context, p), child: const Text('لم تُجمع'))),
        ]),
      ],
      if (open) ...[
        const Divider(),
        OutlinedButton.icon(key: const Key('dump'), onPressed: () => _dump(context), icon: const Icon(Icons.scale), label: const Text('تفريغ في المردم (تذكرة الميزان)')),
      ],
    ])));
  }
}

class _PatrolCard extends StatelessWidget {
  const _PatrolCard({required this.t});
  final DriverTask t;

  Future<void> _scan(BuildContext context, Checkpoint k) async {
    final s = AppScope.of(context);
    final ctl = TextEditingController();
    final tag = await showDialog<String>(context: context, builder: (ctx) => AlertDialog(
      title: Text('مسح: ${k.name}'),
      content: TextField(key: const Key('tag'), controller: ctl, autofocus: true, textDirection: TextDirection.ltr, textCapitalization: TextCapitalization.characters,
          decoration: const InputDecoration(labelText: 'رمز النقطة', helperText: 'الرمز المثبّت في المكان')),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('رجوع')),
        FilledButton(key: const Key('tag-ok'), onPressed: () => Navigator.pop(ctx, ctl.text.trim()), child: const Text('تأكيد')),
      ],
    ));
    if (tag == null || !context.mounted) return;
    if (tag.isEmpty) return toast(context, rejectReasons['tag_required']!, error: true);
    final err = await s.markCheckpoint(t.id, k.id, 'scanned', tag: tag);
    if (!context.mounted) return;
    if (err != null) return toast(context, err, error: true);
    toast(context, 'مُسحت ${k.name}');
  }

  Future<void> _skip(BuildContext context, Checkpoint k) async {
    final s = AppScope.of(context);
    final reason = await showDialog<String>(context: context, builder: (ctx) => SimpleDialog(
      title: Text('لم تُفحص: ${k.name}'),
      children: [for (final e in securitySkipReasons.entries) SimpleDialogOption(onPressed: () => Navigator.pop(ctx, e.key), child: Text(e.value))],
    ));
    if (reason == null || !context.mounted) return;
    final err = await s.markCheckpoint(t.id, k.id, 'skipped', reason: reason);
    if (err != null && context.mounted) toast(context, err, error: true);
  }

  Future<void> _incident(BuildContext context) async {
    final s = AppScope.of(context);
    String category = 'suspicious', severity = 'medium';
    final d = TextEditingController();
    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(builder: (ctx, set) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('بلاغ حادث', style: Theme.of(ctx).textTheme.titleLarge),
          const SizedBox(height: 8),
          Wrap(spacing: 6, runSpacing: 6, children: [for (final e in incidentCategories.entries)
            ChoiceChip(label: Text(e.value), selected: category == e.key, onSelected: (_) => set(() => category = e.key))]),
          const SizedBox(height: 8),
          SegmentedButton<String>(segments: [for (final e in incidentSeverities.entries) ButtonSegment(value: e.key, label: Text(e.value))],
              selected: {severity}, onSelectionChanged: (x) => set(() => severity = x.first)),
          TextField(key: const Key('incident-desc'), controller: d, maxLength: 1000, maxLines: 3, decoration: const InputDecoration(labelText: 'وصف الحادث'), onChanged: (_) => set(() {})),
          FilledButton(key: const Key('incident-ok'), onPressed: d.text.trim().isEmpty ? null : () => Navigator.pop(ctx, true), child: const Text('إرسال البلاغ')),
        ]),
      )),
    );
    if (ok != true || !context.mounted) return;
    final err = await s.reportIncident(t.id, category: category, severity: severity, description: d.text.trim());
    if (!context.mounted) return;
    if (err != null) return toast(context, err, error: true);
    toast(context, s.offline ? 'سُجّل البلاغ وسيُرسل عند عودة الاتصال' : 'وصل البلاغ للمكتب');
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final scheme = Theme.of(context).colorScheme;
    final cps = t.checkpointList;
    final open = t.status == 'in_progress';
    int n(String? e) => cps.where((k) => k.event == e).length;
    return Card(key: const Key('patrol-card'), child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text('جولة حراسة · ${t.attributes['site_code'] ?? ''} · ${t.attributes['slot'] ?? ''}', style: text.labelMedium),
      Text('${t.attributes['site_name'] ?? ''}', style: text.titleLarge),
      if (t.attributes['instructions'] != null) Text('${t.attributes['instructions']}', style: TextStyle(color: scheme.primary)),
      const SizedBox(height: 6),
      Text('مُسحت ${n('scanned')} · لم تُفحص ${n('skipped')} · باقية ${n(null)}${t.incidentCount > 0 ? ' · حوادث ${t.incidentCount}' : ''}',
          key: const Key('patrol-count'), style: const TextStyle(fontWeight: FontWeight.bold)),
      if (!open && ['assigned', 'accepted'].contains(t.status)) const Padding(padding: EdgeInsets.only(top: 4), child: Text('ابدأ الجولة لتسجيل النقاط')),
      for (final k in cps) ...[
        const Divider(),
        Row(children: [
          Ltr('${k.seq}', style: const TextStyle(fontWeight: FontWeight.bold)),
          const SizedBox(width: 8),
          Expanded(child: Text(k.name, style: text.titleSmall)),
          Icon(switch (k.event) { 'scanned' => Icons.check_circle, 'skipped' => Icons.cancel_outlined, _ => Icons.radio_button_unchecked },
              size: 20, color: switch (k.event) { 'scanned' => Colors.green, 'skipped' => scheme.error, _ => null }),
        ]),
        if (k.note != null) Text(k.note!, style: text.bodySmall),
        if (k.event == 'scanned') const Text('مُسحت'),
        if (k.event == 'skipped') Text('لم تُفحص: ${securitySkipReasons[k.reason] ?? k.reason ?? ''}', style: TextStyle(color: scheme.error)),
        if (open) Row(mainAxisAlignment: MainAxisAlignment.end, children: [
          Semantics(button: true, label: 'مسح ${k.name}', excludeSemantics: true, child: TextButton(onPressed: () => _scan(context, k), child: const Text('مسح'))),
          Semantics(button: true, label: 'لم تُفحص ${k.name}', excludeSemantics: true, child: TextButton(onPressed: () => _skip(context, k), child: const Text('لم تُفحص'))),
        ]),
      ],
      if (open) ...[
        const Divider(),
        OutlinedButton.icon(key: const Key('incident'), onPressed: () => _incident(context), icon: Icon(Icons.report_outlined, color: scheme.error), label: const Text('بلاغ حادث')),
      ],
    ])));
  }
}
