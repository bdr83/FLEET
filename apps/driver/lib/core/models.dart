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
  });
  final String id, status, sectorPack;
  final String? taskRef;
  final Map<String, dynamic> attributes;
  final int version;
  final DateTime? windowFrom, windowTo;
  final String? stage;
  final bool hasProof;

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
      );

  /// A local copy after an action the server has not confirmed yet (offline).
  DriverTask copyWith({String? status, String? stage, bool? hasProof}) => DriverTask(
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
      );

  bool get isDelivery => sectorPack == 'delivery@1';
  Map<String, dynamic>? get dropoff => _map(attributes['dropoff']);
  Map<String, dynamic>? get pickup => _map(attributes['pickup']);
  String? get recipientName => _map(attributes['recipient'])?['name'] ?? attributes['recipient_name'];
  String? get recipientPhone => _map(attributes['recipient'])?['phone'] ?? _map(attributes['dropoff'])?['phone'] ?? attributes['recipient_phone'];
  String get address => addressLine(dropoff) ?? (attributes['address'] as String?) ?? '';
  String? get notes => (dropoff?['notes'] as String?) ?? attributes['notes'] as String?;
  String? get ref => taskRef ?? attributes['external_order_id'] as String?;

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
enum TaskAction { accept, atPickup, pickedUp, start, atDropoff, deliver, complete, fail, returned }

List<TaskAction> nextActions(DriverTask t) {
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

const actionLabels = {
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
};
