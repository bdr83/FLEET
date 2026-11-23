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
    this.school,
    this.lifts,
    this.waste,
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
  /// School trips: {trip_id, students: [{id, name, grade, stop_seq, guardian_name, guardian_phone, handover, note, event, received_by, excused}]}.
  final Map<String, dynamic>? school;
  /// Crane working days (cranes pack): the lift plans [{id, ref, time, description, load_t, radius_m, rated_t, utilization, critical, approved, status, wind_limit_ms}].
  final List<dynamic>? lifts;
  /// Waste rounds (waste pack): {run_id, points: [{id, seq, name, area, customer_name, bins: [{type, count}], note, event, bins_emptied, reason}], tickets, net_kg}.
  final Map<String, dynamic>? waste;

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
        school: _map(j['school']),
        lifts: j['lifts'] is List ? j['lifts'] as List : null,
        waste: _map(j['waste']),
      );

  /// A local copy after an action the server has not confirmed yet (offline).
  DriverTask copyWith({String? status, String? stage, bool? hasProof, Map<String, dynamic>? ticket, Map<String, dynamic>? shuttle, Map<String, dynamic>? school, List<dynamic>? lifts, Map<String, dynamic>? waste}) => DriverTask(
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
        school: school ?? this.school,
        lifts: lifts ?? this.lifts,
        waste: waste ?? this.waste,
      );

  bool get isDelivery => sectorPack == 'delivery@1';
  /// A staff-transport trip (shuttle pack): stops with times and the riders to mark boarded or absent.
  bool get isShuttle => sectorPack == 'shuttle@1';
  /// A school trip (school pack), for the driver or the attendant: stops with times and the students to mark boarded,
  /// absent or dropped; a young child going home is handed to a named adult; the trip ends with nobody on the bus.
  bool get isSchool => sectorPack == 'school@1';
  bool get toSchool => attributes['direction'] != 'from_school';
  bool get isAttendant => attributes['kind'] == 'attend';
  List<Student> get students => [for (final x in (school?['students'] as List? ?? const [])) if (x is Map) Student.fromJson(Map<String, dynamic>.from(x))];
  /// Why the trip cannot end yet (same rule as the server), or null.
  String? get schoolFinishBlock {
    final st = students.map((x) => x.state).toList();
    if (st.contains('on_board')) return 'students_on_board';
    if (st.contains('waiting')) return 'students_unmarked';
    return null;
  }
  /// A working day of a hired machine (equipment pack): hour meter at the start and end, downtime and the site supervisor.
  bool get isEquipment => sectorPack == 'equipment@1';
  double? get minHours => _num(attributes['min_hours']);
  /// Car rental (rental pack): deliver the car to the renter (odometer, fuel, the renter's name) or collect it back.
  bool get isRental => sectorPack == 'rental@1' && (attributes['kind'] == 'deliver' || attributes['kind'] == 'collect');
  bool get isCollect => attributes['kind'] == 'collect';
  /// A technician's visit (service pack): arrive, then the result with the work done, the parts and the customer's name.
  bool get isService => sectorPack == 'service@1';
  /// A move (moving pack): the truck's driver loads at the old home, then unloads at the new one with the receiver's name.
  bool get isMoving => sectorPack == 'moving@1' && attributes['kind'] == 'move';
  /// A helper's day on a move: the plain flow (accept, start, done).
  bool get isMoveCrew => sectorPack == 'moving@1' && attributes['kind'] == 'crew';
  /// A container leg (containers pack): pick the box up (confirm its number, the seal), then drop it with the receiver or the gate receipt.
  bool get isContainer => sectorPack == 'containers@1';
  String? get containerNo => attributes['container_no'] as String?;
  bool get needsGateRef => attributes['gate'] == true;
  /// An oilfield journey (oilgas pack): inspect the vehicle → leave (once approved) → call in at the interval → arrive.
  bool get isOilgas => sectorPack == 'oilgas@1';
  /// The lift plans of a crane working day (cranes pack); the day cannot end while one is planned.
  List<Lift> get liftList => [for (final x in lifts ?? const []) if (x is Map) Lift.fromJson(Map<String, dynamic>.from(x))];
  bool get liftsOpen => liftList.any((l) => l.status == 'planned');
  /// A waste collection round (waste pack): the points to mark collected or missed and the weighbridge tickets.
  bool get isWaste => sectorPack == 'waste@1';
  bool get isUtilities => sectorPack == 'utilities@1';
  List<WastePoint> get wastePoints => [for (final x in (waste?['points'] as List? ?? const [])) if (x is Map) WastePoint.fromJson(Map<String, dynamic>.from(x))];
  int get wasteTickets => (waste?['tickets'] as num?)?.toInt() ?? 0;
  /// Why the round cannot end yet: a point unmarked, or something collected without a weighbridge ticket.
  String? get wasteFinishBlock {
    final pts = wastePoints;
    if (pts.any((p) => p.event == null)) return 'points_open';
    if (wasteTickets == 0 && pts.any((p) => p.event == 'collected')) return 'dump_required';
    return null;
  }
  /// A tour bus (tour pack): the group boards (head count, odometer) → back (head count, odometer, a note when fewer) → done.
  bool get isTour => sectorPack == 'tour@1';
  List<Map<String, dynamic>> get itinerary => (attributes['itinerary'] as List? ?? const []).whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList();
  /// A taxi or limousine ride (taxi pack): arrive at the pickup → passenger on board → dropped (km, payment; ends the ride).
  bool get isTaxi => sectorPack == 'taxi@1';
  String? get passengerName => attributes['passenger_name'] as String?;
  String? get passengerPhone => attributes['passenger_phone'] as String?;
  String? get fixedFare => attributes['fixed_fare'] as String?;
  bool get onAccount => attributes['account'] == true;
  /// The fare to show the passenger: the fixed price, or the class tariff for the km and waiting minutes; null when unknown.
  String? fareFor(double km, int waitMin) {
    if (fixedFare != null) return fixedFare;
    final t = _map(attributes['tariff']);
    if (t == null) return null;
    int f(Object? x) => ((double.tryParse('$x') ?? 0) * 1000).round();
    final v = f(t['base']) + (f(t['per_km']) * km).round() + f(t['per_wait_min']) * (waitMin - taxiFreeWaitMin).clamp(0, 10000);
    return ((v > f(t['min_fare']) ? v : f(t['min_fare'])) / 1000).toStringAsFixed(3);
  }
  /// A tanker trip (tankers pack): fill (litres, the source), then discharge (litres, the receiver).
  bool get isTanker => sectorPack == 'tankers@1';
  String? get product => attributes['product'] as String?;
  int? get qtyL => (attributes['qty_l'] as num?)?.toInt();
  int? get capacityL => (attributes['capacity_l'] as num?)?.toInt();
  List<String> get fragileItems => [for (final x in (attributes['fragile'] as List? ?? const [])) if (x is String) x];
  String? get problem => attributes['problem'] as String?;
  String? get category => attributes['category'] as String?;
  bool get urgent => attributes['priority'] == 'urgent';
  Map<String, dynamic>? get unit => _map(attributes['unit']);
  List<String> get previousVisits => [for (final x in (attributes['previous'] as List? ?? const [])) if (x is String) x];
  String? get rentalRef => attributes['rental_ref'] as String?;
  String? get renterName => attributes['renter_name'] as String?;
  String? get renterPhone => attributes['renter_phone'] as String?;
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
  String get address => (isConcrete || isStaffing || isInternal || isDistribution || isFreight || isRental || isService || isMoving || isMoveCrew || isContainer || isTanker || isTaxi || isTour || isOilgas || isWaste || isUtilities ? attributes['address'] as String? : null) ?? addressLine(dropoff) ?? (attributes['address'] as String?) ?? '';
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
enum TaskAction { unloaded, accept, atPickup, pickedUp, start, atDropoff, deliver, complete, fail, returned, loaded, atSite, pourStart, pourEnd, ticket, checkIn, checkOut, vehicleOut, vehicleBack, loadChecked, depart, stopDeliver, routeBack, workStart, workEnd, handover, collected, arrived, workDone, ctrPicked, ctrDropped, tankFilled, tankDischarged, txArrived, txPicked, txDropped, trBoarded, trReturned, ogInspect, ogDepart, ogCheckin, ogArrived, utArrived, utIsolate, utRestored, utReinstated }

List<TaskAction> nextActions(DriverTask t, {DateTime? now}) {
  if (t.isConcrete) return _concreteActions(t);
  if (t.isFreight) return _freightActions(t);
  if (t.isStaffing) return _staffingActions(t, now ?? DateTime.now());
  if (t.isInternal) return _internalActions(t);
  if (t.isEquipment) return _equipmentActions(t);
  if (t.isRental) return _rentalActions(t);
  if (t.isService) return _serviceActions(t);
  if (t.isMoving) return _movingActions(t);
  if (t.isContainer) return _containerActions(t);
  if (t.isTanker) return _tankerActions(t);
  if (t.isTaxi) return _taxiActions(t);
  if (t.isTour) return _tourActions(t);
  if (t.isOilgas) return _oilgasActions(t);
  if (t.isUtilities) return _utilitiesActions(t);
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

/// Rental car: accept → on the way → hand over to the renter, or take it back (odometer, fuel; ends the task).
List<TaskAction> _rentalActions(DriverTask t) {
  switch (t.status) {
    case 'assigned':
      return [TaskAction.accept];
    case 'accepted':
      return [TaskAction.start];
    case 'in_progress':
      return t.stage == 'handover' || t.stage == 'collected' ? [TaskAction.complete] : [t.isCollect ? TaskAction.collected : TaskAction.handover, TaskAction.fail];
    default:
      return [];
  }
}

/// Service visit: accept → on the way → arrived → the result (work, parts, customer) → done.
List<TaskAction> _serviceActions(DriverTask t) {
  switch (t.status) {
    case 'assigned':
      return [TaskAction.accept];
    case 'accepted':
      return [TaskAction.start];
    case 'in_progress':
      return t.stage == 'work_done' ? [TaskAction.complete] : t.stage == 'arrived' ? [TaskAction.workDone, TaskAction.fail] : [TaskAction.arrived, TaskAction.fail];
    default:
      return [];
  }
}

/// Move: accept → on the way → loaded at the old home → unloaded at the new one (receiver's name; ends the move).
List<TaskAction> _movingActions(DriverTask t) {
  switch (t.status) {
    case 'assigned':
      return [TaskAction.accept];
    case 'accepted':
      return [TaskAction.start];
    case 'in_progress':
      return t.stage == 'unloaded' ? [TaskAction.complete] : t.stage == 'loaded' ? [TaskAction.unloaded, TaskAction.fail] : [TaskAction.loaded, TaskAction.fail];
    default:
      return [];
  }
}

/// Container leg: accept → on the way → picked up (the number checked) → dropped (receiver or gate receipt; ends the leg).
List<TaskAction> _containerActions(DriverTask t) {
  switch (t.status) {
    case 'assigned':
      return [TaskAction.accept];
    case 'accepted':
      return [TaskAction.start];
    case 'in_progress':
      return t.stage == 'ctr_dropped' ? [TaskAction.complete] : t.stage == 'ctr_picked' ? [TaskAction.ctrDropped, TaskAction.fail] : [TaskAction.ctrPicked, TaskAction.fail];
    default:
      return [];
  }
}

/// Taxi ride: accept → on the way → arrived → passenger on board → dropped (km, payment) → done. A no-show after waiting.
List<TaskAction> _taxiActions(DriverTask t) {
  switch (t.status) {
    case 'assigned':
      return [TaskAction.accept];
    case 'accepted':
      return [TaskAction.start];
    case 'in_progress':
      return switch (t.stage) {
        'tx_dropped' => [TaskAction.complete],
        'tx_picked' => [TaskAction.txDropped],
        'tx_arrived' => [TaskAction.txPicked, TaskAction.fail],
        _ => [TaskAction.txArrived, TaskAction.fail],
      };
    default:
      return [];
  }
}

/// Tour bus: accept → set off → group on board (heads, odometer) → back (heads, odometer) → done.
List<TaskAction> _tourActions(DriverTask t) {
  switch (t.status) {
    case 'assigned':
      return [TaskAction.accept];
    case 'accepted':
      return [TaskAction.start];
    case 'in_progress':
      return switch (t.stage) {
        'tr_returned' => [TaskAction.complete],
        'tr_boarded' => [TaskAction.trReturned, TaskAction.fail],
        _ => [TaskAction.trBoarded, TaskAction.fail],
      };
    default:
      return [];
  }
}

/// Oilfield journey: accept → start → vehicle inspected → departed (once approved) → call-ins → arrived → done.
List<TaskAction> _oilgasActions(DriverTask t) {
  switch (t.status) {
    case 'assigned':
      return [TaskAction.accept];
    case 'accepted':
      return [TaskAction.start];
    case 'in_progress':
      return switch (t.stage) {
        'og_arrived' => [TaskAction.complete],
        'og_departed' || 'og_checkin' => [TaskAction.ogCheckin, TaskAction.ogArrived, TaskAction.fail],
        'og_inspected' => [TaskAction.ogDepart, TaskAction.fail],
        _ => [TaskAction.ogInspect, TaskAction.fail],
      };
    default:
      return [];
  }
}

/// Utilities work order: accept → start (en route) → arrived → isolated (safety checklist; a dig needs a valid permit)
/// → restored (with the result) → reinstated (digs only) → done.
List<TaskAction> _utilitiesActions(DriverTask t) {
  final dig = t.attributes['needs_permit'] == true;
  switch (t.status) {
    case 'assigned':
      return [TaskAction.accept];
    case 'accepted':
      return [TaskAction.start];
    case 'in_progress':
      return switch (t.stage) {
        'ut_reinstated' => [TaskAction.complete],
        'ut_restored' => dig ? [TaskAction.utReinstated] : [TaskAction.complete],
        'ut_isolated' => [TaskAction.utRestored, TaskAction.fail],
        'ut_arrived' => [TaskAction.utIsolate, TaskAction.fail],
        _ => [TaskAction.utArrived, TaskAction.fail],
      };
    default:
      return [];
  }
}

const utilitiesActionLabels = {
  TaskAction.accept: 'قبول أمر العمل',
  TaskAction.start: 'انطلقت للموقع',
  TaskAction.utArrived: 'وصلت الموقع',
  TaskAction.utIsolate: 'العزل وقائمة السلامة',
  TaskAction.utRestored: 'تم الإصلاح',
  TaskAction.utReinstated: 'أُعيد الطريق',
  TaskAction.complete: 'إغلاق أمر العمل',
  TaskAction.fail: 'تعذّر العمل',
};

/// Same codes as the API (utilities FAIL_REASONS).
const utilitiesFailReasons = {
  'vehicle_breakdown': 'عطل في المركبة',
  'no_access': 'تعذّر الوصول للموقع',
  'permit_refused': 'رُفض التصريح أو أُوقف الحفر',
  'materials_missing': 'نقص في المواد',
  'site_unsafe': 'الموقع غير آمن',
  'other': 'سبب آخر',
};

/// The safety checklist before work, same items as the API (utilities CHECKS); the permit on site only when digging.
const utilitiesChecks = {
  'isolation': 'العزل والقفل (Lock-out) تم',
  'ppe': 'معدات الحماية الشخصية',
  'barriers': 'الحواجز واللوحات التحذيرية',
  'permit_on_site': 'تصريح الحفر في الموقع',
};

/// The repair result, same codes as the API.
const utilitiesResults = {'fixed': 'تم الإصلاح نهائيًا', 'follow_up': 'إصلاح مؤقت، يحتاج متابعة', 'not_fixed': 'لم يُصلح'};
const utNetworkLabels = {'electricity': 'كهرباء', 'water': 'ماء', 'telecom': 'اتصالات'};
const utTypeLabels = {'outage': 'انقطاع', 'repair': 'إصلاح', 'connection': 'توصيل جديد', 'meter': 'عدّاد', 'inspection': 'فحص', 'excavation': 'حفر'};
const utPriorityLabels = {'emergency': 'طارئ', 'urgent': 'عاجل', 'planned': 'مجدول'};

const oilgasActionLabels = {
  TaskAction.accept: 'قبول الرحلة',
  TaskAction.start: 'بدء الرحلة',
  TaskAction.ogInspect: 'فحص المركبة قبل الانطلاق',
  TaskAction.ogDepart: 'انطلقت',
  TaskAction.ogCheckin: 'بلاغ: الوضع سليم',
  TaskAction.ogArrived: 'وصلت الموقع',
  TaskAction.complete: 'إنهاء الرحلة',
  TaskAction.fail: 'تعذّرت الرحلة',
};

/// Same codes as the API (oilgas FAIL_REASONS).
const oilgasFailReasons = {
  'vehicle_breakdown': 'عطل في المركبة',
  'inspection_failed': 'المركبة لم تجتز الفحص',
  'site_closed': 'الموقع مغلق',
  'gate_refused': 'رُفض الدخول من البوابة',
  'weather': 'الطقس (غبار، ضباب)',
  'accident': 'حادث',
  'other': 'سبب آخر',
};

/// The pre-trip checklist, same items as the API (oilgas CHECKS); the H2S monitor only in an H2S zone.
const oilgasChecks = {
  'tyres': 'الإطارات',
  'brakes': 'الفرامل',
  'lights': 'الأضواء',
  'seat_belts': 'أحزمة الأمان',
  'fire_extinguisher': 'طفاية الحريق',
  'first_aid': 'حقيبة الإسعاف',
  'spill_kit': 'عدة احتواء الانسكاب',
  'h2s_monitor': 'جهاز كشف H2S',
};

const tourActionLabels = {
  TaskAction.accept: 'قبول الرحلة',
  TaskAction.start: 'انطلقت لنقطة التجمع',
  TaskAction.trBoarded: 'صعد الركاب، انطلقنا',
  TaskAction.trReturned: 'عدنا، تسجيل العودة',
  TaskAction.complete: 'إنهاء الرحلة',
  TaskAction.fail: 'تعذّرت الرحلة',
};

/// Same codes as the API (tour FAIL_REASONS).
const tourFailReasons = {
  'bus_breakdown': 'عطل في الحافلة',
  'accident': 'حادث',
  'border_refused': 'رُفض العبور في المنفذ',
  'group_canceled': 'ألغت المجموعة الرحلة',
  'other': 'سبب آخر',
};

/// A count or an odometer typed by the driver (Arabic digits accepted), 0..max; null when invalid.
int? parseCount(String raw, int max) {
  final s = raw.trim().replaceAllMapped(RegExp('[٠-٩]'), (m) => '${m[0]!.codeUnitAt(0) - 0x0660}').replaceAll(RegExp('[,٬]'), '');
  final n = int.tryParse(s);
  return n == null || n < 0 || n > max ? null : n;
}

/// Same as the API (taxi FREE_WAIT_MIN). [تخمين]
const taxiFreeWaitMin = 5;

/// Trip km typed by the driver: 0-1000, one decimal (Arabic digits and a comma accepted).
double? parseKm(String raw) {
  final s = raw.trim().replaceAllMapped(RegExp('[٠-٩]'), (m) => '${m[0]!.codeUnitAt(0) - 0x0660}').replaceAll(RegExp('[,٫]'), '.');
  if (!RegExp(r'^\d{1,4}(\.\d)?$').hasMatch(s)) return null;
  final n = double.parse(s);
  return n > 1000 ? null : n;
}

const taxiActionLabels = {
  TaskAction.accept: 'قبول الحجز',
  TaskAction.start: 'انطلقت للراكب',
  TaskAction.txArrived: 'وصلت لمكان الراكب',
  TaskAction.txPicked: 'ركب الراكب',
  TaskAction.txDropped: 'وصلنا، إنهاء المشوار',
  TaskAction.complete: 'إنهاء الحجز',
  TaskAction.fail: 'تعذّر المشوار',
};

/// Same codes as the API (taxi FAIL_REASONS).
const taxiFailReasons = {
  'passenger_no_show': 'الراكب لم يحضر (بعد 10 دقائق انتظار)',
  'passenger_canceled': 'ألغى الراكب',
  'vehicle_breakdown': 'عطل في السيارة',
  'other': 'سبب آخر',
};
const taxiClassLabels = {'sedan': 'صالون', 'suv': 'دفع رباعي', 'van': 'فان', 'luxury': 'ليموزين فاخرة'};
const paymentLabels = {'cash': 'نقدًا', 'card': 'بطاقة', 'account': 'على حساب الشركة'};

/// Tanker trip: accept → on the way → filled (litres, source) → discharged (litres, receiver; ends the trip).
List<TaskAction> _tankerActions(DriverTask t) {
  switch (t.status) {
    case 'assigned':
      return [TaskAction.accept];
    case 'accepted':
      return [TaskAction.start];
    case 'in_progress':
      return t.stage == 'tank_discharged' ? [TaskAction.complete] : t.stage == 'tank_filled' ? [TaskAction.tankDischarged, TaskAction.fail] : [TaskAction.tankFilled, TaskAction.fail];
    default:
      return [];
  }
}

/// Litres typed by the driver: a whole number 0-60000 (Arabic digits and thousands commas accepted).
int? parseLitres(String raw) {
  final s = raw.trim().replaceAllMapped(RegExp('[٠-٩]'), (m) => '${m[0]!.codeUnitAt(0) - 0x0660}').replaceAll(RegExp('[,٬]'), '');
  final n = int.tryParse(s);
  return n == null || n < 0 || n > 60000 ? null : n;
}

/// ISO 6346 container number with its check digit (spaces and dashes dropped); null when invalid.
String? normContainer(String raw) {
  final s = raw.toUpperCase().replaceAll(RegExp(r'[\s-]'), '');
  if (!RegExp(r'^[A-Z]{3}[UJZR][0-9]{7}$').hasMatch(s)) return null;
  final letters = <String, int>{};
  var n = 10;
  for (final ch in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')) {
    if (n % 11 == 0) n++;
    letters[ch] = n++;
  }
  var sum = 0;
  for (var i = 0; i < 10; i++) {
    sum += (i < 4 ? letters[s[i]]! : int.parse(s[i])) * (1 << i);
  }
  return (sum % 11) % 10 == int.parse(s[10]) ? s : null;
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
                    : t.isSchool
                    ? (schoolActionLabels[a] ?? actionLabels[a]!)
                    : t.isEquipment
                        ? (equipmentActionLabels[a] ?? actionLabels[a]!)
                        : t.isService
                            ? (serviceActionLabels[a] ?? actionLabels[a]!)
                            : t.isMoving
                            ? (movingActionLabels[a] ?? actionLabels[a]!)
                            : t.isContainer
                            ? (containerActionLabels[a] ?? actionLabels[a]!)
                            : t.isTanker
                            ? (tankerActionLabels[a] ?? actionLabels[a]!)
                            : t.isTaxi
                            ? (taxiActionLabels[a] ?? actionLabels[a]!)
                            : t.isTour
                            ? (tourActionLabels[a] ?? actionLabels[a]!)
                            : t.isOilgas
                            ? (oilgasActionLabels[a] ?? actionLabels[a]!)
                            : t.isWaste
                            ? (wasteActionLabels[a] ?? actionLabels[a]!)
                            : t.isUtilities
                            ? (utilitiesActionLabels[a] ?? actionLabels[a]!)
                            : t.isMoveCrew
                            ? (moveCrewActionLabels[a] ?? actionLabels[a]!)
                            : t.isRental
                            ? ((t.isCollect && a == TaskAction.start ? 'انطلقت لاستلام السيارة' : null) ?? rentalActionLabels[a] ?? actionLabels[a]!)
                            : actionLabels[a]!;

const tankerActionLabels = {
  TaskAction.accept: 'قبول الطلب',
  TaskAction.start: 'انطلقت للتعبئة',
  TaskAction.tankFilled: 'تمت التعبئة',
  TaskAction.tankDischarged: 'تم التفريغ',
  TaskAction.complete: 'إنهاء الطلب',
  TaskAction.fail: 'تعذّر التوصيل',
};

/// Same codes as the API (tankers FAIL_REASONS).
const tankerFailReasons = {
  'customer_absent': 'العميل غير موجود',
  'no_access': 'تعذّر الوصول للخزان',
  'tank_full': 'الخزان ممتلئ',
  'source_closed': 'محطة التعبئة مغلقة',
  'truck_breakdown': 'عطل الصهريج',
  'customer_canceled': 'ألغى العميل',
  'other': 'سبب آخر',
};
const tankerProductLabels = {'water_fresh': 'ماء عذب', 'water_brackish': 'ماء صليبي', 'diesel': 'ديزل', 'kerosene': 'كيروسين'};

const containerActionLabels = {
  TaskAction.accept: 'قبول الرحلة',
  TaskAction.start: 'انطلقت لسحب الحاوية',
  TaskAction.ctrPicked: 'سحبت الحاوية',
  TaskAction.ctrDropped: 'سلّمت الحاوية',
  TaskAction.complete: 'إنهاء الرحلة',
  TaskAction.fail: 'تعذّرت الرحلة',
};

/// Same codes as the API (containers FAIL_REASONS).
const containerFailReasons = {
  'not_released': 'الحاوية غير مفرج عنها',
  'port_closed': 'البوابة مغلقة أو زحام',
  'customer_absent': 'العميل غير موجود',
  'truck_breakdown': 'عطل الشاحنة',
  'wrong_container': 'حاوية مختلفة',
  'other': 'سبب آخر',
};
const containerLegLabels = {'port_to_customer': 'من الميناء إلى العميل', 'empty_to_depot': 'إرجاع الفارغة للساحة', 'empty_to_customer': 'فارغة من الساحة إلى العميل', 'full_to_port': 'الممتلئة إلى الميناء', 'transfer': 'نقل حاوية'};
const containerTypeLabels = {'dry': 'جاف', 'high_cube': 'عالي', 'reefer': 'مبرد', 'open_top': 'مفتوح السقف', 'flat_rack': 'مسطح', 'tank': 'صهريج'};

const movingActionLabels = {
  TaskAction.accept: 'قبول النقل',
  TaskAction.start: 'انطلقت للعميل',
  TaskAction.loaded: 'انتهى التحميل',
  TaskAction.unloaded: 'انتهى التفريغ والتسليم',
  TaskAction.complete: 'إنهاء النقل',
  TaskAction.fail: 'تعذّر النقل',
};
const moveCrewActionLabels = {
  TaskAction.accept: 'قبول المهمة',
  TaskAction.start: 'بدأت العمل',
  TaskAction.complete: 'انتهى العمل',
  TaskAction.fail: 'تعذّر الحضور',
};

/// Same codes as the API (moving FAIL_REASONS).
const movingFailReasons = {
  'customer_absent': 'العميل غير موجود',
  'no_access': 'تعذّر الدخول أو التحميل',
  'customer_canceled': 'ألغى العميل',
  'truck_breakdown': 'عطل الشاحنة',
  'other': 'سبب آخر',
};
const moveSizeLabels = {'room': 'غرفة', 'studio': 'استوديو', 'apt_1': 'شقة غرفة', 'apt_2': 'شقة غرفتين', 'apt_3': 'شقة 3 غرف', 'apt_4': 'شقة 4 غرف+', 'villa': 'فيلا / بيت', 'office': 'مكتب'};
const moveServiceLabels = {'packing': 'تغليف', 'assembly': 'فك وتركيب', 'crating': 'صناديق خشبية', 'storage': 'تخزين', 'cleaning': 'تنظيف'};

const serviceActionLabels = {
  TaskAction.accept: 'قبول الزيارة',
  TaskAction.start: 'انطلقت للعميل',
  TaskAction.arrived: 'وصلت للموقع',
  TaskAction.workDone: 'انتهت الزيارة',
  TaskAction.fail: 'تعذّرت الزيارة',
};

/// Same codes as the API (service FAIL_REASONS).
const serviceFailReasons = {
  'customer_absent': 'العميل غير موجود',
  'no_access': 'تعذّر الدخول للموقع',
  'customer_canceled': 'ألغى العميل',
  'other': 'سبب آخر',
};

const serviceCategoryLabels = {'ac': 'تكييف', 'electrical': 'كهرباء', 'plumbing': 'سباكة', 'appliance': 'أجهزة منزلية', 'elevator': 'مصاعد', 'generator': 'مولدات', 'other': 'أخرى'};
const serviceResultLabels = {'fixed': 'تم الإصلاح', 'follow_up': 'يحتاج زيارة أخرى', 'not_fixed': 'لم يُصلح'};

/// A quantity of a part typed by the technician: more than 0, up to two decimals (Arabic digits and comma accepted).
double? parseQty(String s) {
  final t = s.trim().replaceAll('٫', '.').replaceAll(',', '.').split('').map((c) {
    final i = '٠١٢٣٤٥٦٧٨٩'.indexOf(c);
    return i >= 0 ? '$i' : c;
  }).join();
  if (!RegExp(r'^\d{1,4}(\.\d{1,2})?$').hasMatch(t)) return null;
  final n = double.parse(t);
  return n > 0 ? n : null;
}

const rentalActionLabels = {
  TaskAction.accept: 'قبول المهمة',
  TaskAction.start: 'انطلقت للعميل',
  TaskAction.handover: 'سلّمت السيارة للعميل',
  TaskAction.collected: 'استلمت السيارة من العميل',
  TaskAction.fail: 'تعذّر',
};

/// Same codes as the API (rental FAIL_REASONS).
const rentalFailReasons = {
  'customer_absent': 'العميل غير موجود',
  'customer_refused': 'رفض العميل',
  'licence_invalid': 'رخصة القيادة غير صالحة',
  'vehicle_issue': 'مشكلة في السيارة',
  'other': 'سبب آخر',
};

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

const schoolActionLabels = {
  TaskAction.accept: 'قبول الرحلة',
  TaskAction.start: 'انطلقت',
  TaskAction.complete: 'وصلت وأنهيت الرحلة',
  TaskAction.fail: 'تعذّر تشغيل الرحلة',
};

/// Same codes as the API (school FAIL_REASONS).
const schoolFailReasons = {
  'vehicle_breakdown': 'عطل في الحافلة',
  'accident': 'حادث',
  'road_closed': 'الطريق مغلق',
  'school_closed': 'المدرسة مغلقة',
  'other': 'سبب آخر',
};

/// A student on a school trip and where they stand: waiting, on_board, dropped, absent, or excused (absence notice).
class Student {
  Student({required this.id, required this.name, this.grade, required this.stopSeq, this.guardianName, this.guardianPhone, this.handover = false, this.note, this.event, this.receivedBy, this.excused = false});
  factory Student.fromJson(Map<String, dynamic> j) => Student(id: j['id'] as String, name: j['name'] as String? ?? '', grade: j['grade'] as String?,
      stopSeq: (j['stop_seq'] as num?)?.toInt() ?? 1, guardianName: j['guardian_name'] as String?, guardianPhone: j['guardian_phone'] as String?,
      handover: j['handover'] == true, note: j['note'] as String?, event: j['event'] as String?, receivedBy: j['received_by'] as String?, excused: j['excused'] == true);
  final String id, name;
  final String? grade, guardianName, guardianPhone, note, event, receivedBy;
  final int stopSeq;
  final bool handover, excused;
  String get state => event == 'boarded' ? 'on_board' : event == 'dropped' ? 'dropped' : event == 'absent' ? 'absent' : excused ? 'excused' : 'waiting';
  Map<String, dynamic> toJson() => {'id': id, 'name': name, 'grade': grade, 'stop_seq': stopSeq, 'guardian_name': guardianName, 'guardian_phone': guardianPhone,
      'handover': handover, 'note': note, 'event': event, 'received_by': receivedBy, 'excused': excused};
}

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
    t.isConcrete ? concreteFailReasons : t.isFreight ? freightFailReasons : t.isStaffing ? staffingFailReasons : t.isInternal ? internalFailReasons : t.isDistribution ? distFailReasons : t.isShuttle ? shuttleFailReasons : t.isSchool ? schoolFailReasons : t.isEquipment ? equipmentFailReasons : t.isRental ? rentalFailReasons : t.isService ? serviceFailReasons : t.isMoving || t.isMoveCrew ? movingFailReasons : t.isContainer ? containerFailReasons : t.isTanker ? tankerFailReasons : t.isTaxi ? taxiFailReasons : t.isTour ? tourFailReasons : t.isOilgas ? oilgasFailReasons : t.isWaste ? wasteFailReasons : t.isUtilities ? utilitiesFailReasons : t.isDelivery ? failReasons : null;

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
  'payment_required': 'اختر طريقة الدفع',
  'km_required': 'أدخل كيلومترات المشوار',
  'no_account': 'هذا الحجز ليس على حساب شركة',
  'not_arrived': 'سجّل وصولك لمكان الراكب أولًا',
  'wait_more': 'انتظر 10 دقائق من الوصول قبل تسجيل عدم حضور الراكب',
  'checks_required': 'أكمل قائمة الفحص',
  'inspection_failed': 'المركبة لم تجتز الفحص، أصلح الخلل أو أبلغ المكتب',
  'not_approved': 'لم تُعتمد خطة الرحلة بعد، تواصل مع مدير الرحلات',
  'headcount_required': 'أدخل عدد الركاب',
  'over_seats': 'العدد أكثر من مقاعد الحافلة',
  'note_required': 'العائدون أقل من الصاعدين، اكتب السبب',
  'unknown_student': 'الطالب ليس على هذا الخط، حدّث القائمة',
  'students_on_board': 'ما زال طالب في الحافلة، سجّل نزوله قبل إنهاء الرحلة',
  'students_unmarked': 'سجّل صعود كل طالب أو غيابه قبل إنهاء الرحلة',
  'not_on_board': 'الطالب لم يُسجَّل صعوده',
  'already_on_board': 'الطالب في الحافلة، سجّل نزوله أولًا',
  'meter_required': 'أدخل قراءة عدّاد الساعات',
  'lifts_open': 'سجّل كل رفعة منفذة أو موقوفة قبل إنهاء يوم العمل',
  'points_open': 'سجّل كل نقطة جُمعت أو لم تُجمع قبل إنهاء الجولة',
  'dump_required': 'سجّل تذكرة ميزان المردم قبل إنهاء الجولة',
  'bins_required': 'أدخل عدد الحاويات المفرّغة',
  'bins_invalid': 'عدد الحاويات أكثر من المسجّل للنقطة',
  'miss_reason_required': 'اختر سبب عدم الجمع',
  'unknown_point': 'النقطة ليست على هذا الخط، حدّث القائمة',
  'ticket_required': 'أدخل رقم تذكرة الميزان',
  'weight_required': 'أدخل الوزن الصافي',
  'ticket_already_recorded': 'التذكرة مسجّلة مسبقًا',
  'lift_not_approved': 'رفعة حرجة لم تُعتمد بعد، لا تنفذها وتواصل مع المكتب',
  'wind_required': 'أدخل سرعة الرياح',
  'wind_too_high': 'الرياح فوق حد الرافعة، أوقف الرفعة',
  'abort_reason_required': 'اكتب سبب الإيقاف',
  'lift_closed': 'الرفعة مسجّلة مسبقًا',
  'unknown_lift': 'الرفعة ليست على هذا اليوم، حدّث القائمة',
  'meter_too_low': 'العدّاد أقل من آخر قراءة مسجّلة للمعدة',
  'meter_invalid': 'قراءة الانتهاء يجب أن تكون بعد قراءة البدء وخلال 24 ساعة',
  'signer_required': 'اكتب اسم مشرف الموقع',
  'result_required': 'اختر نتيجة الزيارة',
  'permit_required': 'لا عزل ولا حفر بلا تصريح حفر، تواصل مع المكتب',
  'permit_expired': 'تصريح الحفر منتهٍ، لا تبدأ العمل وتواصل مع المكتب',
  'checks_failed': 'قائمة السلامة غير مكتملة، لا تبدأ العمل',
  'reinstatement_required': 'سجّل إعادة الطريق قبل إغلاق الأمر',
  'not_required': 'هذا الأمر لا يحتاج إعادة طريق',
  'work_required': 'اكتب ما تم من عمل',
  'parts_invalid': 'تحقق من القطع والكميات',
  'vehicle_still_out': 'السيارة ما زالت مؤجرة لعميل آخر',
  'vehicle_out_of_service': 'السيارة خارج الخدمة',
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

/// A crane lift plan on a working day: what is lifted, the load against the rated capacity, and where it stands.
class Lift {
  Lift({required this.id, required this.ref, this.time, required this.description, required this.loadT, required this.radiusM, required this.ratedT, required this.utilization,
      this.critical = false, this.approved = false, required this.status, this.windLimit = 9.8});
  factory Lift.fromJson(Map<String, dynamic> j) => Lift(id: j['id'] as String, ref: j['ref'] as String? ?? '', time: (j['time'] as String?)?.substring(0, 5), description: j['description'] as String? ?? '',
      loadT: (j['load_t'] as num?)?.toDouble() ?? 0, radiusM: (j['radius_m'] as num?)?.toDouble() ?? 0, ratedT: (j['rated_t'] as num?)?.toDouble() ?? 0,
      utilization: (j['utilization'] as num?)?.toDouble() ?? 0, critical: j['critical'] == true, approved: j['approved'] == true, status: j['status'] as String? ?? 'planned',
      windLimit: (j['wind_limit_ms'] as num?)?.toDouble() ?? 9.8);
  final String id, ref, description, status;
  final String? time;
  final double loadT, radiusM, ratedT, utilization, windLimit;
  final bool critical, approved;
  bool get blocked => critical && !approved;
}

const wasteActionLabels = {
  TaskAction.accept: 'قبول الجولة',
  TaskAction.start: 'بدأت الجولة',
  TaskAction.complete: 'أنهيت الجولة',
  TaskAction.fail: 'تعذّرت الجولة',
};
/// Same codes as the API (waste FAIL_REASONS).
const wasteFailReasons = {
  'vehicle_breakdown': 'عطل في الكابسة',
  'accident': 'حادث',
  'road_closed': 'الطريق مغلق',
  'facility_closed': 'المردم مغلق',
  'other': 'سبب آخر',
};
const wasteBinLabels = {'bin_120': 'حاوية 120 لتر', 'bin_240': 'حاوية 240 لتر', 'bin_660': 'حاوية 660 لتر', 'bin_1100': 'حاوية 1100 لتر', 'skip_6': 'سكيب 6 م³', 'skip_12': 'سكيب 12 م³', 'compactor': 'كابسة ثابتة', 'bag': 'أكياس'};
const wasteMissReasons = {'no_access': 'لا يمكن الوصول', 'bins_not_out': 'الحاويات غير موجودة', 'blocked': 'مغلقة بسيارة أو عائق', 'contaminated': 'نفايات غير مطابقة', 'other': 'سبب آخر'};

/// A collection point on a waste round: the customer's bins and where it stands (collected with bins emptied, or missed with a reason).
class WastePoint {
  WastePoint({required this.id, required this.seq, required this.name, this.area, this.customerName, this.bins = const [], this.note, this.event, this.binsEmptied, this.reason});
  factory WastePoint.fromJson(Map<String, dynamic> j) => WastePoint(id: j['id'] as String, seq: (j['seq'] as num?)?.toInt() ?? 0, name: j['name'] as String? ?? '', area: j['area'] as String?,
      customerName: j['customer_name'] as String?, note: j['note'] as String?, event: j['event'] as String?, binsEmptied: (j['bins_emptied'] as num?)?.toInt(), reason: j['reason'] as String?,
      bins: [for (final b in (j['bins'] as List? ?? const [])) if (b is Map) (type: '${b['type']}', count: (b['count'] as num?)?.toInt() ?? 1)]);
  final String id, name;
  final int seq;
  final String? area, customerName, note, event, reason;
  final int? binsEmptied;
  final List<({String type, int count})> bins;
  int get binCount => bins.fold(0, (n, b) => n + b.count);
  String get binsText => bins.map((b) => '${b.count} × ${wasteBinLabels[b.type] ?? b.type}').join('، ');
}
