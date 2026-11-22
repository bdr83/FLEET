/// Data the driver app reads from the API, plus the pure rules the screens use.
library;

class Worker {
  Worker({required this.id, required this.displayName, required this.kind, required this.status});
  final String id, displayName, kind, status;
  factory Worker.fromJson(Map<String, dynamic> j) =>
      Worker(id: j['id'], displayName: j['display_name'] ?? '', kind: j['kind'] ?? '', status: j['status'] ?? '');
}

class Shift {
  Shift({required this.id, required this.startedAt, this.assetId, this.plateNo, this.startOdometerKm});
  final String id;
  final DateTime startedAt;
  final String? assetId, plateNo;
  final int? startOdometerKm;
  factory Shift.fromJson(Map<String, dynamic> j) => Shift(
        id: j['id'],
        startedAt: DateTime.parse(j['started_at']),
        assetId: j['asset_id'],
        plateNo: j['plate_no'],
        startOdometerKm: (j['start_odometer_km'] as num?)?.toInt(),
      );
}

class Vehicle {
  Vehicle({required this.id, this.plateNo, required this.type, this.odometerKm});
  final String id, type;
  final String? plateNo;
  final int? odometerKm;
  factory Vehicle.fromJson(Map<String, dynamic> j) =>
      Vehicle(id: j['id'], plateNo: j['plate_no'], type: j['asset_type'] ?? '', odometerKm: (j['odometer_km'] as num?)?.toInt());
}

class DriverTask {
  DriverTask({
    required this.id,
    required this.status,
    required this.sectorPack,
    required this.attributes,
    required this.version,
    this.windowFrom,
    this.windowTo,
    this.stage,
    this.hasProof = false,
    this.taskRef,
    this.ticket,
    this.freight,
    this.shuttle,
  });
  final String id, status, sectorPack;
  final String? taskRef;
  final Map<String, dynamic> attributes;
  final int version;
  final DateTime? windowFrom, windowTo;
  final String? stage;
  final bool hasProof;
  /// Concrete loads: the delivery ticket (ticket_no, volume_m3, batched_at, signed, planned_arrival, site_ready, mix_code).
  final Map<String, dynamic>? ticket;
  /// Freight trips: the waybill (waybill_no, mode, cargo, pickup, dropoff, trailer_plate, loaded_weight_kg, seal_no, received_by).
  final Map<String, dynamic>? freight;
  /// Staff transport trips: {trip_id, riders: [{id, name, staff_no, phone, stop_seq, event}]}.
  final Map<String, dynamic>? shuttle;

  factory DriverTask.fromJson(Map<String, dynamic> j) => DriverTask(
        id: j['id'],
        status: j['status'],
        sectorPack: j['sector_pack'] ?? '',
        attributes: Map<String, dynamic>.from(j['attributes'] ?? const {}),
        version: (j['version'] as num?)?.toInt() ?? 0,
        windowFrom: j['window_from'] == null ? null : DateTime.parse(j['window_from']),
        windowTo: j['window_to'] == null ? null : DateTime.parse(j['window_to']),
        stage: j['stage'],
        hasProof: j['has_proof'] == true,
        taskRef: j['ref'],
        ticket: _map(j['ticket']),
        freight: _map(j['freight']),
        shuttle: _map(j['shuttle']),
      );

  /// A local copy after an action the server has not confirmed yet (offline).
  DriverTask copyWith({String? status, String? stage, bool? hasProof, Map<String, dynamic>? ticket, Map<String, dynamic>? shuttle}) => DriverTask(
        id: id,
        status: status ?? this.status,
        sectorPack: sectorPack,
        attributes: attributes,
        version: version,
        windowFrom: windowFrom,
        windowTo: windowTo,
        stage: stage ?? this.stage,
        hasProof: hasProof ?? this.hasProof,
        taskRef: taskRef,
        ticket: ticket ?? this.ticket,
        freight: freight,
        shuttle: shuttle ?? this.shuttle,
      );

  bool get isDelivery => sectorPack == 'delivery@1';
  /// A staff-transport trip (shuttle pack): stops with times and the riders to mark boarded or absent.
  bool get isShuttle => sectorPack == 'shuttle@1';
  /// A working day of a hired machine (equipment pack): hour meter at the start and end, downtime and the site supervisor.
  bool get isEquipment => sectorPack == 'equipment@1';
  double? get minHours => _num(attributes['min_hours']);
  List<ShuttleStop> get shuttleStops => [for (final x in (attributes['stops'] as List? ?? const [])) if (x is Map) ShuttleStop.fromJson(Map<String, dynamic>.from(x))];
  List<Rider> get riders => [for (final x in (shuttle?['riders'] as List? ?? const [])) if (x is Map) Rider.fromJson(Map<String, dynamic>.from(x))];
  int get boardedCount => riders.where((r) => r.event == 'boarded').length;
  int? get capacity => attributes['capacity'] is num ? (attributes['capacity'] as num).toInt() : null;
  bool get toWork => attributes['direction'] != 'from_work';
  /// A haulage trip with its waybill: at the pickup → loaded (weight, seal) → on the road → at the drop-off → unloaded (receiver).
  bool get isFreight => sectorPack == 'freight@1' && freight != null;
  String? get waybillNo => freight?['waybill_no'] as String?;
  Map<String, dynamic> get cargo => _map(freight?['cargo']) ?? const {};
  String? get trailerPlate => freight?['trailer_plate'] as String?;
  String get pickupLine => (attributes['pickup_address'] as String?) ?? addressLine(pickup) ?? '';
  /// A concrete load planned from a pour order (it has a ticket). A bare concrete@1 task keeps the simple flow.
  bool get isConcrete => sectorPack == 'concrete@1' && ticket != null;
  /// A day-shift of a driver placed with a customer (driver supply): check in at the site, check out at the end.
  bool get isStaffing => sectorPack == 'staffing@1';
  /// A trip of the company's own fleet (in-house): take the vehicle with its odometer, drive the employee, bring it back.
  bool get isInternal => sectorPack == 'internal@1';
  String? get purpose => attributes['purpose'] as String?;
  String? get department => attributes['department'] as String?;
  String? get requester => attributes['requester'] as String?;
  String? get requesterPhone => attributes['requester_phone'] as String?;
  int? get passengers => attributes['passengers'] is num ? (attributes['passengers'] as num).toInt() : null;
  /// Own-fleet distribution: the day's route (load list, depart, back at the depot) and its stops (deliver, returns, cash).
  bool get isDistribution => sectorPack == 'distribution@1';
  bool get isRoute => isDistribution && attributes['kind'] == 'route';
  bool get isStop => isDistribution && attributes['kind'] == 'stop';
  String? get routeRef => attributes['route_ref'] as String?;
  int? get seq => attributes['seq'] is num ? (attributes['seq'] as num).toInt() : null;
  bool get payCash => attributes['payment'] == 'cash';
  /// Cold chain (coldchain pack): chilled or frozen route or stop, with the range the readings are checked against.
  String? get tempClass => attributes['temp_class'] as String?;
  bool get isCold => tempClass != null && tempClass != 'ambient';
  double? get tempMin => _num(attributes['temp_min']);
  double? get tempMax => _num(attributes['temp_max']);
  int get stopsCount => attributes['stops'] is num ? (attributes['stops'] as num).toInt() : 0;
  List<DistItem> get distItems => [for (final i in (attributes['items'] as List? ?? const [])) if (i is Map) DistItem.fromJson(Map<String, dynamic>.from(i))];
  List<DistItem> get loadList => [for (final i in (attributes['load'] as List? ?? const [])) if (i is Map) DistItem.fromJson(Map<String, dynamic>.from(i))];
  String? get shift => attributes['shift'] as String?;
  String? get workDate => attributes['work_date'] as String?;
  String? get requestRef => attributes['request_ref'] as String?;
  String? get ticketNo => ticket?['ticket_no'] as String? ?? attributes['ticket_no'] as String?;
  double get volumeM3 => _num(ticket?['volume_m3']) ?? _num(attributes['volume_m3']) ?? 0;
  String? get mixCode => ticket?['mix_code'] as String? ?? attributes['mix_code'] as String?;
  DateTime? get batchedAt => ticket?['batched_at'] == null ? null : DateTime.tryParse(ticket!['batched_at']);
  DateTime? get plannedArrival => (ticket?['planned_arrival'] ?? attributes['planned_arrival']) is String ? DateTime.tryParse(ticket?['planned_arrival'] ?? attributes['planned_arrival']) : null;
  bool get siteReady => ticket?['site_ready'] != false;
  String? get siteContact => dropoff?['contact_name'] as String?;
  String? get sitePhone => dropoff?['contact_phone'] as String?;
  Map<String, dynamic>? get dropoff => _map(attributes['dropoff']);
  Map<String, dynamic>? get pickup => _map(attributes['pickup']);
  String? get recipientName => _map(attributes['recipient'])?['name'] ?? attributes['recipient_name'];
  String? get recipientPhone => _map(attributes['recipient'])?['phone'] ?? _map(attributes['dropoff'])?['phone'] ?? attributes['recipient_phone'];
  String get address => (isConcrete || isStaffing || isInternal || isDistribution || isFreight ? attributes['address'] as String? : null) ?? addressLine(dropoff) ?? (attributes['address'] as String?) ?? '';
  String? get notes => (dropoff?['notes'] as String?) ?? attributes['notes'] as String?;
  String? get ref => taskRef ?? attributes['external_order_id'] as String?;

  /// Courier pack: a delivery task with a waybill, pieces and the attempt number.
  String? get awb => isDelivery ? attributes['awb'] as String? : null;
  int get pieces => attributes['pieces'] is num ? (attributes['pieces'] as num).toInt() : 1;
  int get attempt => attributes['attempt'] is num ? (attributes['attempt'] as num).toInt() : 1;
  int? get maxAttempts => attributes['max_attempts'] is num ? (attributes['max_attempts'] as num).toInt() : null;
  /// "2 قطع · المحاولة 2 من 3" (the attempt only from the second one); the waybill is shown on its own, left to right.
  String? get parcelLine => awb == null ? null : ['$pieces ${pieces == 1 ? 'قطعة' : 'قطع'}', if (attempt > 1 && maxAttempts != null) 'المحاولة $attempt من $maxAttempts'].join(' · ');

  /// Cash to collect, in fils (3 decimals), or 0.
  int get codFils => moneyToFils(attributes['cod_amount']);

  /// Where to navigate: pickup until the parcel is picked up, then the drop-off.
  ({double lat, double lng})? get target {
    final p = (stage == null || stage == 'at_pickup') && pickup?['lat'] != null ? pickup : dropoff;
    if (p == null || p['lat'] is! num || p['lng'] is! num) return null;
    return (lat: (p['lat'] as num).toDouble(), lng: (p['lng'] as num).toDouble());
  }
}

Map<String, dynamic>? _map(Object? v) => v is Map ? Map<String, dynamic>.from(v) : null;
double? _num(Object? v) => v is num ? v.toDouble() : v is String ? double.tryParse(v) : null;

/// "8.5" / "8,5" / "٨٫٥" → 8.5 with up to 2 decimals, or null.
double? parseM3(String s) {
  const ar = '٠١٢٣٤٥٦٧٨٩';
  var t = s.trim().replaceAll('٫', '.').replaceAll(',', '.');
  for (var i = 0; i < 10; i++) {
    t = t.replaceAll(ar[i], '$i');
  }
  if (!RegExp(r'^\d{1,2}(\.\d{1,2})?$').hasMatch(t)) return null;
  return double.parse(t);
}

/// Checks a ticket before it is queued: the same rule the server applies (poured + returned ≤ load + 0.05 m³).
String? ticketError(double load, double? poured, double? returned, String signedBy) {
  if (poured == null) return 'أدخل الكمية المصبوبة';
  if (returned == null) return 'أدخل الكمية المرتجعة (0 إن لم يوجد)';
  if (poured + returned > load + 0.05) return 'المصبوب والمرتجع أكثر من حمولة الخلاطة';
  if (signedBy.trim().isEmpty) return 'اكتب اسم مهندس الموقع';
  return null;
}

/// "السالمية، ق 5، ش 10، م 12" — same format as the API and the dashboard.
String? addressLine(Map<String, dynamic>? a) {
  if (a == null) return null;
  final parts = <String>[
    ?_s(a['area']),
    if (_s(a['block']) case final v?) 'ق $v',
    if (_s(a['street']) case final v?) 'ش $v',
    if (_s(a['avenue']) case final v?) 'ج $v',
    if (_s(a['house']) case final v?) 'م $v',
    if (_s(a['floor']) case final v?) 'دور $v',
    if (_s(a['apartment']) case final v?) 'شقة $v',
  ];
  return parts.isEmpty ? null : parts.join('، ');
}

String? _s(Object? v) => v is String && v.trim().isNotEmpty ? v.trim() : null;

/// "7.500" → 7500 fils. Bad or missing values are 0.
int moneyToFils(Object? v) {
  final s = v is num ? v.toString() : v is String ? v : '';
  final m = RegExp(r'^(\d{1,12})(?:\.(\d{1,3}))?$').firstMatch(s.trim());
  if (m == null) return 0;
  return int.parse(m[1]!) * 1000 + int.parse((m[2] ?? '').padRight(3, '0'));
}

String filsToMoney(int fils) => '${fils ~/ 1000}.${(fils % 1000).toString().padLeft(3, '0')}';

/// What the driver can do next on a task, in the order the buttons appear.
enum TaskAction { unloaded, accept, atPickup, pickedUp, start, atDropoff, deliver, complete, fail, returned, loaded, atSite, pourStart, pourEnd, ticket, checkIn, checkOut, vehicleOut, vehicleBack, loadChecked, depart, stopDeliver, routeBack, workStart, workEnd }

List<TaskAction> nextActions(DriverTask t, {DateTime? now}) {
  if (t.isConcrete) return _concreteActions(t);
  if (t.isFreight) return _freightActions(t);
  if (t.isStaffing) return _staffingActions(t, now ?? DateTime.now());
  if (t.isInternal) return _internalActions(t);
  if (t.isEquipment) return _equipmentActions(t);
  if (t.isRoute) return _routeActions(t);
  if (t.isStop) return ['accepted', 'in_progress'].contains(t.status) ? [TaskAction.stopDeliver, TaskAction.fail] : [];
  switch (t.status) {
    case 'assigned':
      return [TaskAction.accept];
    case 'accepted':
      if (!t.isDelivery) return [TaskAction.start];
      return [
        if (t.stage == null) TaskAction.atPickup,
        if (t.stage != 'picked_up') TaskAction.pickedUp,
        if (t.stage == 'picked_up') TaskAction.start,
      ];
    case 'in_progress':
      if (!t.isDelivery) return [TaskAction.complete, TaskAction.fail];
      return [if (t.stage != 'at_dropoff') TaskAction.atDropoff, TaskAction.deliver, TaskAction.fail];
    case 'failed':
      return t.isDelivery && t.stage != 'returned_to_sender' ? [TaskAction.returned] : [];
    default:
      return [];
  }
}

/// Mixer trip: loaded at the plant → heading out → on site → pour start → pour end → signed ticket → done.
List<TaskAction> _concreteActions(DriverTask t) {
  switch (t.status) {
    case 'assigned':
      return [TaskAction.accept];
    case 'accepted':
      return t.stage == null ? [TaskAction.loaded] : [TaskAction.start];
    case 'in_progress':
      return switch (t.stage) {
        null => [TaskAction.loaded, TaskAction.fail],
        'loaded' => [TaskAction.atSite, TaskAction.fail],
        'at_site' => [TaskAction.pourStart, TaskAction.fail],
        'pour_start' => [TaskAction.pourEnd],
        _ => t.hasProof ? [TaskAction.complete] : [TaskAction.ticket],
      };
    default:
      return [];
  }
}

/// Haulage trip: accept → at the pickup → loaded (weight, seal) → on the road → at the drop-off → unloaded (receiver) → done.
List<TaskAction> _freightActions(DriverTask t) {
  switch (t.status) {
    case 'assigned':
      return [TaskAction.accept];
    case 'accepted':
      return switch (t.stage) { null => [TaskAction.atPickup], 'at_pickup' => [TaskAction.loaded], _ => [TaskAction.start] };
    case 'in_progress':
      return switch (t.stage) {
        'at_dropoff' => [TaskAction.unloaded, TaskAction.fail],
        'unloaded' => [TaskAction.complete],
        _ => [TaskAction.atDropoff, TaskAction.fail],
      };
    default:
      return [];
  }
}

/// Same rule as the server: check-in opens two hours before the shift starts.
const earlyCheckIn = Duration(hours: 2);
bool checkInOpen(DriverTask t, DateTime now) => t.windowFrom == null || !now.isBefore(t.windowFrom!.subtract(earlyCheckIn));

/// Driver supply day-shift: one tap to check in at the customer's site (accepts and starts the shift), one to check out.
List<TaskAction> _staffingActions(DriverTask t, DateTime now) {
  switch (t.status) {
    case 'assigned':
    case 'accepted':
      return checkInOpen(t, now) ? [TaskAction.checkIn] : [];
    case 'in_progress':
      return t.stage == 'check_out' ? [TaskAction.complete] : [TaskAction.checkOut, TaskAction.fail];
    default:
      return [];
  }
}

/// In-house trip: accept → take the vehicle (odometer; starts the trip) → bring it back (odometer; ends the trip).
List<TaskAction> _internalActions(DriverTask t) {
  switch (t.status) {
    case 'assigned':
      return [TaskAction.accept];
    case 'accepted':
      return [TaskAction.vehicleOut];
    case 'in_progress':
      return t.stage == 'vehicle_back' ? [TaskAction.complete] : [TaskAction.vehicleBack, TaskAction.fail];
    default:
      return [];
  }
}

/// Hired machine: accept → start work (hour meter) → end work (meter, downtime, supervisor; ends the day).
List<TaskAction> _equipmentActions(DriverTask t) {
  switch (t.status) {
    case 'assigned':
      return [TaskAction.accept];
    case 'accepted':
      return [TaskAction.workStart];
    case 'in_progress':
      return [TaskAction.workEnd, TaskAction.fail];
    default:
      return [];
  }
}

/// Distribution route: accept → check the load (odometer) → leave the depot → (stops) → back at the depot (odometer) → done.
List<TaskAction> _routeActions(DriverTask t) {
  switch (t.status) {
    case 'assigned':
      return [TaskAction.accept];
    case 'accepted':
      return t.stage == null ? [TaskAction.loadChecked] : [TaskAction.depart];
    case 'in_progress':
      return t.stage == 'route_back' ? [TaskAction.complete] : [TaskAction.routeBack];
    default:
      return [];
  }
}

/// The button text, worded for the kind of task.
String actionLabel(DriverTask t, TaskAction a) => t.isConcrete
    ? (concreteActionLabels[a] ?? actionLabels[a]!)
    : t.isFreight
    ? (freightActionLabels[a] ?? actionLabels[a]!)
    : t.isStaffing
        ? (staffingActionLabels[a] ?? actionLabels[a]!)
        : t.isInternal
            ? (internalActionLabels[a] ?? actionLabels[a]!)
            : t.isDistribution
                ? (distActionLabels[a] ?? actionLabels[a]!)
                : t.isShuttle
                    ? (shuttleActionLabels[a] ?? actionLabels[a]!)
                    : t.isEquipment
                        ? (equipmentActionLabels[a] ?? actionLabels[a]!)
                        : actionLabels[a]!;

const equipmentActionLabels = {
  TaskAction.accept: 'قبول يوم العمل',
  TaskAction.workStart: 'بدأت العمل',
  TaskAction.workEnd: 'انتهى العمل',
  TaskAction.fail: 'تعذّر العمل اليوم',
};

/// Same codes as the API (equipment FAIL_REASONS).
const equipmentFailReasons = {
  'equipment_breakdown': 'عطل في المعدة',
  'site_not_ready': 'الموقع غير جاهز',
  'weather': 'الطقس',
  'customer_canceled': 'ألغى العميل',
  'other': 'سبب آخر',
};

const machineTypeLabels = {'excavator': 'حفارة', 'loader': 'شيول', 'crane': 'رافعة (كرين)', 'forklift': 'رافعة شوكية', 'bulldozer': 'بلدوزر', 'roller': 'مدحلة', 'grader': 'جريدر'};

/// An hour-meter reading typed by the operator: hours with up to one decimal (Arabic digits and comma accepted).
double? parseMeter(String s) {
  final t = s.trim().replaceAll('٫', '.').replaceAll(',', '.').split('').map((c) {
    final i = '٠١٢٣٤٥٦٧٨٩'.indexOf(c);
    return i >= 0 ? '$i' : c;
  }).join();
  if (!RegExp(r'^\d{1,7}(\.\d)?$').hasMatch(t)) return null;
  return double.parse(t);
}

const shuttleActionLabels = {
  TaskAction.accept: 'قبول الرحلة',
  TaskAction.start: 'انطلقت',
  TaskAction.complete: 'وصلت وأنهيت الرحلة',
  TaskAction.fail: 'تعذّر تشغيل الرحلة',
};

/// Same codes as the API (shuttle FAIL_REASONS).
const shuttleFailReasons = {
  'vehicle_breakdown': 'عطل في الحافلة',
  'accident': 'حادث',
  'road_closed': 'الطريق مغلق',
  'trip_canceled': 'أُلغيت الرحلة',
  'other': 'سبب آخر',
};

/// A stop of a staff-transport route with its planned time.
class ShuttleStop {
  ShuttleStop({required this.name, this.area, required this.time});
  factory ShuttleStop.fromJson(Map<String, dynamic> j) => ShuttleStop(name: j['name'] as String? ?? '', area: j['area'] as String?, time: j['time'] as String? ?? '');
  final String name, time;
  final String? area;
}

/// An employee on the trip and the standing mark: boarded, no_show or null (not marked yet).
class Rider {
  Rider({required this.id, required this.name, this.staffNo, this.phone, required this.stopSeq, this.event});
  factory Rider.fromJson(Map<String, dynamic> j) => Rider(id: j['id'] as String, name: j['name'] as String? ?? '', staffNo: j['staff_no'] as String?, phone: j['phone'] as String?,
      stopSeq: (j['stop_seq'] as num?)?.toInt() ?? 1, event: j['event'] as String?);
  final String id, name;
  final String? staffNo, phone, event;
  final int stopSeq;
  Map<String, dynamic> toJson() => {'id': id, 'name': name, 'staff_no': staffNo, 'phone': phone, 'stop_seq': stopSeq, 'event': event};
}

const distActionLabels = {
  TaskAction.accept: 'قبول المسار',
  TaskAction.loadChecked: 'راجعت الحمولة',
  TaskAction.depart: 'انطلقت من المستودع',
  TaskAction.routeBack: 'عدت للمستودع',
  TaskAction.complete: 'إنهاء المسار',
  TaskAction.stopDeliver: 'تسليم',
  TaskAction.fail: 'تعذّر التسليم',
};

/// A product line of a stop or of the load list.
class DistItem {
  DistItem({required this.sku, required this.name, required this.qty, this.price, this.expiry});
  factory DistItem.fromJson(Map<String, dynamic> j) => DistItem(sku: j['sku'] as String, name: (j['name'] as String?) ?? j['sku'] as String, qty: _num(j['qty']) ?? 0, price: j['price'] as String?, expiry: j['expiry'] as String?);
  final String? expiry;
  final String sku;
  final String name;
  final double qty;
  final String? price;
  int get priceFils => moneyToFils(price);
}

/// Value of quantities at the stop's prices, in fils (what a cash customer pays).
int distValueFils(List<DistItem> items, Map<String, double> qty) {
  var total = 0;
  for (final i in items) {
    total += ((qty[i.sku] ?? 0) * 1000).round() * i.priceFils ~/ 1000;
  }
  return total;
}

/// "12" / "2.5" with up to 3 decimals.
String qtyText(double q) => q == q.roundToDouble() ? q.toInt().toString() : q.toStringAsFixed(3).replaceFirst(RegExp(r'0+$'), '');

const freightActionLabels = {
  TaskAction.accept: 'قبول الرحلة',
  TaskAction.atPickup: 'وصلت لنقطة التحميل',
  TaskAction.loaded: 'تم التحميل',
  TaskAction.start: 'انطلقت إلى التفريغ',
  TaskAction.atDropoff: 'وصلت لنقطة التفريغ',
  TaskAction.unloaded: 'تم التفريغ والتسليم',
  TaskAction.complete: 'إنهاء الرحلة',
  TaskAction.fail: 'تعذّر إكمال الرحلة',
};

/// Same codes as the API (freight FAIL_REASONS).
const freightFailReasons = {
  'truck_breakdown': 'عطل الشاحنة',
  'refused_by_consignee': 'رفض المستلم',
  'weight_mismatch': 'اختلاف الوزن',
  'cargo_damaged': 'حمولة تالفة',
  'address_not_found': 'لم أجد العنوان',
  'cargo_not_ready': 'الحمولة غير جاهزة',
  'customer_canceled': 'ألغاه العميل',
  'other': 'سبب آخر',
};

const internalActionLabels = {
  TaskAction.accept: 'قبول المشوار',
  TaskAction.vehicleOut: 'استلمت المركبة',
  TaskAction.vehicleBack: 'أرجعت المركبة',
  TaskAction.complete: 'إنهاء المشوار',
  TaskAction.fail: 'تعذّر إكمال المشوار',
};

const staffingActionLabels = {
  TaskAction.checkIn: 'تسجيل الحضور',
  TaskAction.checkOut: 'تسجيل الانصراف',
  TaskAction.complete: 'إنهاء المناوبة',
  TaskAction.fail: 'مغادرة قبل نهاية الدوام',
};

const concreteActionLabels = {
  TaskAction.accept: 'قبول الحمولة',
  TaskAction.loaded: 'تم التحميل من المحطة',
  TaskAction.start: 'انطلقت إلى الموقع',
  TaskAction.atSite: 'وصلت للموقع',
  TaskAction.pourStart: 'بدأ الصب',
  TaskAction.pourEnd: 'انتهى الصب',
  TaskAction.ticket: 'توقيع تذكرة التسليم',
  TaskAction.complete: 'إنهاء الحمولة',
  TaskAction.fail: 'تعذّر التسليم',
};

const actionLabels = {
  TaskAction.unloaded: 'تم التفريغ',
  TaskAction.accept: 'قبول المهمة',
  TaskAction.atPickup: 'وصلت لنقطة الاستلام',
  TaskAction.pickedUp: 'استلمت الشحنة',
  TaskAction.start: 'بدء التوصيل',
  TaskAction.atDropoff: 'وصلت للمستلم',
  TaskAction.deliver: 'تسليم',
  TaskAction.complete: 'إنهاء المهمة',
  TaskAction.fail: 'تعذّر التنفيذ',
  TaskAction.returned: 'أعدتها للمرسل',
};

const statusLabels = {
  'assigned': 'مسندة إليك',
  'accepted': 'مقبولة',
  'in_progress': 'قيد التنفيذ',
  'completed': 'مكتملة',
  'failed': 'تعذّرت',
};

const stageLabels = {
  'at_pickup': 'عند نقطة الاستلام',
  'picked_up': 'استلم الشحنة',
  'at_dropoff': 'عند المستلم',
  'returned_to_sender': 'أُعيدت للمرسل',
  'loaded': 'محمّلة',
  'at_site': 'في الموقع',
  'pour_start': 'جارٍ الصب',
  'pour_end': 'انتهى الصب',
  'unloaded': 'فُرّغت',
  'check_in': 'سجّل الحضور',
  'check_out': 'سجّل الانصراف',
  'vehicle_out': 'المركبة معك',
  'vehicle_back': 'أُرجعت المركبة',
  'load_checked': 'الحمولة جاهزة',
  'route_back': 'عاد للمستودع',
};

/// Same codes as the API (staffing FAIL_REASONS).
const staffingFailReasons = {
  'sick': 'مرض',
  'vehicle_breakdown': 'عطل في المركبة',
  'sent_home_by_customer': 'صرفني العميل',
  'other': 'سبب آخر',
};

/// The failure reasons offered for the task's kind, or null when a free-text reason is asked.
Map<String, String>? failReasonsFor(DriverTask t) =>
    t.isConcrete ? concreteFailReasons : t.isFreight ? freightFailReasons : t.isStaffing ? staffingFailReasons : t.isInternal ? internalFailReasons : t.isDistribution ? distFailReasons : t.isShuttle ? shuttleFailReasons : t.isEquipment ? equipmentFailReasons : t.isDelivery ? failReasons : null;

/// Same codes as the API (internal FAIL_REASONS).
const internalFailReasons = {
  'vehicle_breakdown': 'عطل في المركبة',
  'accident': 'حادث',
  'trip_canceled': 'أُلغي المشوار',
  'other': 'سبب آخر',
};

/// Same codes as the API (distribution FAIL_REASONS) offered at a stop.
const distFailReasons = {
  'shop_closed': 'المحل مغلق',
  'refused': 'رفض الاستلام',
  'no_cash': 'لا يوجد نقد',
  'no_space': 'لا مكان للتخزين',
  'temp_out_of_range': 'رفض: الحرارة خارج النطاق',
  'expired': 'رفض: منتهي الصلاحية',
  'late_window': 'رفض: خارج نافذة التسليم',
  'other': 'سبب آخر',
};

/// Fuel gauge in eighths, as the office records it.
String fuelLabel(int n) => n == 8 ? 'ممتلئ' : n == 0 ? 'فارغ' : '$n/8';

/// Same codes as the API (concrete FAIL_REASONS).
const concreteFailReasons = {
  'site_not_ready': 'الموقع غير جاهز',
  'age_exceeded': 'تجاوزت الخرسانة العمر المسموح',
  'rejected_by_site': 'رفضها مهندس الموقع',
  'truck_breakdown': 'عطل في الخلاطة',
  'pump_breakdown': 'عطل في المضخة',
  'customer_canceled': 'ألغى العميل',
  'other': 'سبب آخر',
};

/// Same codes as the API (FAIL_REASONS).
const failReasons = {
  'recipient_absent': 'المستلم غير موجود',
  'wrong_address': 'العنوان خاطئ',
  'recipient_refused': 'رفض الاستلام',
  'unreachable': 'تعذّر الاتصال بالمستلم',
  'damaged': 'الشحنة تالفة',
  'cod_not_paid': 'لم يدفع المبلغ',
  'customer_canceled': 'ألغى العميل الطلب',
  'other': 'سبب آخر',
};

/// Readable Arabic for the server's rejection reasons in /driver/sync.
const rejectReasons = {
  'receiver_required': 'اكتب اسم المستلم',
  'wrong_pin': 'رمز المستلم غير صحيح',
  'pin_locked': 'أُقفل الرمز بعد 5 محاولات خاطئة. سلّم بصورة أو توقيع وسيراجعها المكتب',
  'proof_required': 'التسليم يحتاج رمز المستلم أو صورة',
  'already_proven': 'إثبات التسليم مسجّل مسبقًا',
  'invalid_transition': 'حالة المهمة تغيّرت، حدّث القائمة',
  'invalid_stage': 'هذه المرحلة غير متاحة الآن',
  'not_assigned_to_you': 'المهمة لم تعد مسندة إليك',
  'reason_required': 'اختر سبب التعذّر',
  'bad_time': 'وقت الجهاز غير صحيح، اضبط الساعة',
  'no_pin': 'لا يوجد رمز لهذه المهمة',
  'not_supported': 'غير متاح لهذا النوع من المهام',
  'stage_out_of_order': 'سجّل المرحلة السابقة أولًا',
  'stage_already_recorded': 'المرحلة مسجّلة مسبقًا',
  'already_signed': 'التذكرة موقّعة مسبقًا',
  'quantity_exceeds_load': 'المصبوب والمرتجع أكثر من حمولة الخلاطة',
  'invalid_reason': 'سبب غير مناسب لهذا النوع من المهام',
  'too_early': 'يفتح تسجيل الحضور قبل بداية الدوام بساعتين',
  'odometer_required': 'أدخل قراءة العدّاد',
  'odometer_too_low': 'العدّاد أقل من آخر قراءة مسجّلة للمركبة',
  'vehicle_booked': 'المركبة محجوزة لمشوار آخر قبل موعدك',
  'route_not_started': 'ابدأ المسار من المستودع أولًا',
  'stops_open': 'سجّل كل التوقفات قبل العودة',
  'stop_already_recorded': 'التوقف مسجّل مسبقًا',
  'quantity_exceeds_plan': 'الكمية أكثر من المخطط لهذا التوقف',
  'item_not_planned': 'صنف غير مخطط لهذا التوقف',
  'cash_required': 'أدخل المبلغ المحصّل',
  'unknown_rider': 'الراكب ليس على هذا الخط، حدّث القائمة',
  'meter_required': 'أدخل قراءة عدّاد الساعات',
  'meter_too_low': 'العدّاد أقل من آخر قراءة مسجّلة للمعدة',
  'meter_invalid': 'قراءة الانتهاء يجب أن تكون بعد قراءة البدء وخلال 24 ساعة',
  'signer_required': 'اكتب اسم مشرف الموقع',
};

const tempClassLabels = {'chilled': 'مبرد', 'frozen': 'مجمد', 'ambient': 'عادي'};

/// A temperature typed by the driver: -50..60 °C, one decimal, Arabic digits and comma accepted.
double? parseCelsius(String s) {
  final t = s.trim().replaceAll('٫', '.').replaceAll(',', '.').replaceAll('−', '-').split('').map((c) {
    final i = '٠١٢٣٤٥٦٧٨٩'.indexOf(c);
    return i >= 0 ? '$i' : c;
  }).join();
  if (!RegExp(r'^-?\d{1,2}(\.\d)?$').hasMatch(t)) return null;
  final n = double.parse(t);
  return n < -50 || n > 60 ? null : n;
}
