import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';
import 'api.dart';
import 'config.dart';
import 'models.dart';
import 'queue.dart';
import 'tracker.dart';

const _uuid = Uuid();
String newOpId() => _uuid.v4();
String nowIso() => DateTime.now().toUtc().toIso8601String();

/// Everything the screens read: session, worker, shift, tasks and the offline queue.
class AppState extends ChangeNotifier {
  AppState({Api? api, QueueStore? queueStore, QueueStore? pointStore})
      : api = api ?? Api(),
        _queueStore = queueStore ?? PrefsQueueStore('queue_v1'),
        _pointStore = pointStore ?? PrefsQueueStore('points_v1');
  final Api api;
  final QueueStore _queueStore, _pointStore;
  late final OpQueue queue = OpQueue(api, _queueStore)..onChange = notifyListeners;
  late final Tracker tracker = Tracker(api, _pointStore);

  bool ready = false, offline = false, loading = false;
  Worker? worker;
  Shift? shift;
  List<DriverTask> tasks = [];
  String? error;
  Timer? _timer;

  bool get signedIn => api.signedIn;

  /// Server address chosen on the login screen (pilot/test servers); falls back to the build-time API_URL.
  Future<void> setServer(String url) async {
    final u = url.trim().replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.tryParse(u);
    if (uri == null || !(uri.scheme == 'https' || uri.scheme == 'http') || uri.host.isEmpty) throw const FormatException('عنوان غير صالح');
    api.baseUrl = u;
    await (await SharedPreferences.getInstance()).setString('server', u);
    notifyListeners();
  }

  Future<void> boot() async {
    final saved = (await SharedPreferences.getInstance()).getString('server');
    if (saved != null) api.baseUrl = saved;
    api.onSignedOut = () { worker = null; shift = null; tasks = []; notifyListeners(); };
    await queue.init();
    await tracker.init();
    if (await api.restore()) await refresh();
    ready = true;
    notifyListeners();
    _timer = Timer.periodic(flushEvery, (_) => sync());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  // ---- login ----
  Future<({String? devCode})> requestCode(String phone) async {
    final r = await api.postPublic('/v1/auth/otp/request', {'phone': phone});
    return (devCode: r?['dev_code'] as String?);
  }

  /// Returns the companies the number belongs to; signs in directly when there is one.
  Future<List<Map<String, dynamic>>> verifyCode(String phone, String code) async =>
      _afterLogin(await api.postPublic('/v1/auth/otp/verify', {'phone': phone, 'code': code}));

  /// Email + password; same company handling as the phone login.
  Future<List<Map<String, dynamic>>> signInWithPassword(String email, String password) async =>
      _afterLogin(await api.postPublic('/v1/auth/login', {'email': email.trim(), 'password': password}));

  Future<List<Map<String, dynamic>>> _afterLogin(dynamic r) async {
    _userToken = r['user_token'];
    final ms = (r['memberships'] as List).map((m) => Map<String, dynamic>.from(m)).toList();
    final drivers = ms.where((m) => m['role_code'] == 'driver').toList();
    final pick = drivers.length == 1 ? drivers : (ms.length == 1 ? ms : null);
    if (pick != null) await chooseCompany(pick.first['tenant_id']);
    return ms;
  }

  String? _userToken;
  Future<void> chooseCompany(String tenantId) async {
    final r = await api.postPublic('/v1/auth/token', {'tenant_id': tenantId}, bearer: _userToken);
    await api.setSession(r['access_token'], r['refresh_token']);
    _userToken = null;
    await refresh();
  }

  Future<void> signOut() async {
    await sync();
    await tracker.stop();
    await api.signOut();
    worker = null; shift = null; tasks = [];
    notifyListeners();
  }

  // ---- data ----
  Future<void> refresh() async {
    loading = true;
    notifyListeners();
    try {
      await queue.flush();
      final me = await api.get('/v1/driver/me');
      worker = Worker.fromJson(me['worker']);
      shift = me['open_shift'] == null ? null : Shift.fromJson(me['open_shift']);
      final t = await api.get('/v1/driver/tasks?include=returns');
      tasks = (t['data'] as List).map((j) => DriverTask.fromJson(j)).toList();
      offline = false;
      error = null;
      if (shift != null && !tracker.running) error = await tracker.start();
      if (shift == null && tracker.running) await tracker.stop();
    } on ApiException catch (e) {
      offline = e.isNetwork;
      if (!e.isNetwork) error = e.message;
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  /// Background tick: send queued actions and GPS points.
  Future<void> sync() async {
    if (!signedIn) return;
    final before = queue.pending;
    await queue.flush();
    await tracker.flush();
    offline = queue.pending > 0 && queue.pending == before;
    notifyListeners();
  }

  // ---- shift ----
  Future<List<Vehicle>> vehicles() async =>
      ((await api.get('/v1/driver/assets'))['data'] as List).map((j) => Vehicle.fromJson(j)).toList();

  Future<void> startShift({String? assetId, int? odometerKm}) async {
    final r = await api.post('/v1/driver/shifts', {
      'client_op_id': newOpId(),
      'asset_id': ?assetId,
      'odometer_km': ?odometerKm,
      'started_at': nowIso(),
    });
    shift = Shift.fromJson(r);
    error = await tracker.start();
    notifyListeners();
  }

  Future<void> endShift({int? odometerKm}) async {
    final s = shift;
    if (s == null) return;
    await tracker.flush();
    await api.post('/v1/driver/shifts/${s.id}/end', {'odometer_km': ?odometerKm, 'ended_at': nowIso()});
    await tracker.stop();
    shift = null;
    notifyListeners();
  }

  // ---- task actions (queued, applied locally at once) ----
  DriverTask? task(String id) => tasks.where((t) => t.id == id).firstOrNull;

  void _local(String id, DriverTask Function(DriverTask) f) {
    tasks = [for (final t in tasks) t.id == id ? f(t) : t];
    tasks.removeWhere((t) => (t.status == 'completed') || (t.status == 'failed' && (t.stage == 'returned_to_sender' || t.isStop)));
    notifyListeners();
  }

  Future<OpResult?> _syncOp(String taskId, Map<String, dynamic> op, {bool wait = false}) async {
    final id = newOpId();
    await queue.add({'kind': 'sync', 'task_id': taskId, 'op': {'client_op_id': id, 'task_id': taskId, 'occurred_at': nowIso(), ...op}});
    if (!wait) {
      unawaited(queue.flush());
      return null;
    }
    await queue.flush();
    return queue.resultOf(id);
  }

  Future<void> setStatus(String taskId, String status, {String? reasonCode, String? note}) async {
    _local(taskId, (t) => t.copyWith(status: status));
    await _syncOp(taskId, {'type': 'task_status', 'to_status': status, 'reason_code': ?reasonCode, 'note': ?note});
  }

  Future<void> milestone(String taskId, String code, {Map<String, dynamic> extra = const {}}) async {
    final p = await tracker.current();
    // batching starts the concrete age clock: show it at once, the server keeps its own time from this op
    _local(taskId, (t) => t.copyWith(stage: code,
        ticket: t.isConcrete && code == 'loaded' && t.batchedAt == null ? {...t.ticket!, 'batched_at': nowIso()} : null));
    await _syncOp(taskId, {'type': 'milestone', 'code': code, if (p != null) 'lat': p.latitude, if (p != null) 'lng': p.longitude, ...extra});
  }

  /// Staff transport: marks a rider boarded or absent (shown at once, queued offline; the last mark counts).
  Future<void> markRider(String taskId, String riderId, String event) async {
    _local(taskId, (t) => t.copyWith(shuttle: {
          ...?t.shuttle,
          'riders': [for (final r in t.riders) r.id == riderId ? {...r.toJson(), 'event': event} : r.toJson()],
        }));
    await _syncOp(taskId, {'type': 'board', 'rider_id': riderId, 'event': event});
  }

  /// School transport: marks a student boarded, absent or dropped (shown at once, queued offline; the last mark counts).
  /// A young child going home is dropped with the name of the adult who took them.
  Future<void> markStudent(String taskId, String studentId, String event, {String? receivedBy}) async {
    _local(taskId, (t) => t.copyWith(school: {
          ...?t.school,
          'students': [for (final x in t.students) x.id == studentId ? {...x.toJson(), 'event': event, 'received_by': receivedBy} : x.toJson()],
        }));
    await _syncOp(taskId, {'type': 'student', 'student_id': studentId, 'event': event, 'received_by': ?receivedBy});
  }

  /// Cold chain: a temperature reading on the route, typed from the truck's display (queued offline like any op).
  Future<String?> tempReading(String routeTaskId, double celsius) async {
    final r = await _syncOp(routeTaskId, {'type': 'temp', 'reading_c': celsius}, wait: true);
    if (r != null && !r.ok) return _refused(routeTaskId, r);
    return null;
  }

  /// Driver supply: checking in accepts the day-shift if needed, records the check-in with the position (the office sees
  /// how far from the site it was) and starts the shift. Queued in order, so it works offline too.
  Future<void> checkIn(String taskId) async {
    final t = task(taskId);
    if (t == null) return;
    final p = await tracker.current();
    _local(taskId, (x) => x.copyWith(status: 'in_progress', stage: 'check_in'));
    if (t.status == 'assigned') await _syncOp(taskId, {'type': 'task_status', 'to_status': 'accepted'});
    await _syncOp(taskId, {'type': 'milestone', 'code': 'check_in', if (p != null) 'lat': p.latitude, if (p != null) 'lng': p.longitude});
    await _syncOp(taskId, {'type': 'task_status', 'to_status': 'in_progress'});
  }

  /// Checking out ends the shift: the server computes the worked hours from check-in to check-out.
  Future<void> checkOut(String taskId) async {
    final p = await tracker.current();
    _local(taskId, (x) => x.copyWith(status: 'completed', stage: 'check_out'));
    await _syncOp(taskId, {'type': 'milestone', 'code': 'check_out', if (p != null) 'lat': p.latitude, if (p != null) 'lng': p.longitude});
    await _syncOp(taskId, {'type': 'task_status', 'to_status': 'completed'});
  }

  /// In-house trip: the driver takes the vehicle with its odometer (and fuel), which starts the trip. Online the server answers
  /// at once so a wrong reading shows on the screen; offline both steps are queued in order.
  Future<String?> vehicleOut(String taskId, {required int odometerKm, int? fuel}) async {
    final r = await _syncOp(taskId, {'type': 'milestone', 'code': 'vehicle_out', 'odometer_km': odometerKm, 'fuel': ?fuel}, wait: true);
    if (r != null && !r.ok) return _refused(taskId, r);
    _local(taskId, (x) => x.copyWith(status: 'in_progress', stage: 'vehicle_out'));
    await _syncOp(taskId, {'type': 'task_status', 'to_status': 'in_progress'});
    return null;
  }

  /// Bringing the vehicle back records the odometer and ends the trip; the office sees the distance at once.
  Future<String?> vehicleBack(String taskId, {required int odometerKm, int? fuel}) async {
    final r = await _syncOp(taskId, {'type': 'milestone', 'code': 'vehicle_back', 'odometer_km': odometerKm, 'fuel': ?fuel}, wait: true);
    if (r != null && !r.ok) return _refused(taskId, r);
    _local(taskId, (x) => x.copyWith(status: 'completed', stage: 'vehicle_back'));
    await _syncOp(taskId, {'type': 'task_status', 'to_status': 'completed'});
    return null;
  }

  /// Hired machine: the operator starts work with the hour meter (checked online at once; queued offline), which starts the day.
  Future<String?> workStart(String taskId, double meter) async {
    final r = await _syncOp(taskId, {'type': 'milestone', 'code': 'work_start', 'meter_hours': meter}, wait: true);
    if (r != null && !r.ok) return _refused(taskId, r);
    _local(taskId, (x) => x.copyWith(status: 'in_progress', stage: 'work_start'));
    await _syncOp(taskId, {'type': 'task_status', 'to_status': 'in_progress'});
    return null;
  }

  /// End of the working day: hour meter, downtime from breakdowns and the site supervisor who confirmed; ends the day.
  Future<String?> workEnd(String taskId, double meter, {double downtime = 0, required String signedBy}) async {
    final r = await _syncOp(taskId, {'type': 'milestone', 'code': 'work_end', 'meter_hours': meter, 'downtime_hours': downtime, 'received_by': signedBy}, wait: true);
    if (r != null && !r.ok) return _refused(taskId, r);
    _local(taskId, (x) => x.copyWith(status: 'completed', stage: 'work_end'));
    await _syncOp(taskId, {'type': 'task_status', 'to_status': 'completed'});
    return null;
  }

  /// Service visit: the result, the work done, the parts used and the customer's name; checked online at once, then ends the visit.
  Future<String?> serviceDone(String taskId, {required String result, required String workDone, required String signedBy, List<Map<String, dynamic>> parts = const []}) async {
    final r = await _syncOp(taskId, {'type': 'milestone', 'code': 'work_done', 'result': result, 'note': workDone, 'received_by': signedBy, 'parts': parts}, wait: true);
    if (r != null && !r.ok) return _refused(taskId, r);
    _local(taskId, (x) => x.copyWith(status: 'completed', stage: 'work_done'));
    await _syncOp(taskId, {'type': 'task_status', 'to_status': 'completed'});
    return null;
  }

  /// Taxi: the drop with the trip km and the payment (checked online at once), then ends the ride.
  Future<String?> taxiDropped(String taskId, {double? km, required String payment}) async {
    final r = await _syncOp(taskId, {'type': 'milestone', 'code': 'tx_dropped', 'trip_km': ?km, 'payment': payment}, wait: true);
    if (r != null && !r.ok) return _refused(taskId, r);
    _local(taskId, (x) => x.copyWith(status: 'completed', stage: 'tx_dropped'));
    await _syncOp(taskId, {'type': 'task_status', 'to_status': 'completed'});
    return null;
  }

  /// Tour bus: the group on board, with the head count and the odometer (checked online at once against the seats).
  Future<String?> tourBoarded(String taskId, {required int headcount, required int odometer}) async {
    final r = await _syncOp(taskId, {'type': 'milestone', 'code': 'tr_boarded', 'headcount': headcount, 'odometer_km': odometer}, wait: true);
    if (r != null && !r.ok) return _refused(taskId, r);
    _local(taskId, (x) => x.copyWith(stage: 'tr_boarded'));
    return null;
  }

  /// Tour bus: back, with the head count, the odometer and why fewer came back; then ends the trip.
  Future<String?> tourReturned(String taskId, {required int headcount, required int odometer, String? note}) async {
    final r = await _syncOp(taskId, {'type': 'milestone', 'code': 'tr_returned', 'headcount': headcount, 'odometer_km': odometer, 'note': ?note}, wait: true);
    if (r != null && !r.ok) return _refused(taskId, r);
    _local(taskId, (x) => x.copyWith(status: 'completed', stage: 'tr_returned'));
    await _syncOp(taskId, {'type': 'task_status', 'to_status': 'completed'});
    return null;
  }

  /// Tanker: the litres filled and where (checked online at once against the tanker's capacity).
  Future<String?> tankFilled(String taskId, {required int litres, String? source}) async {
    final r = await _syncOp(taskId, {'type': 'milestone', 'code': 'tank_filled', 'litres': litres, 'note': ?source}, wait: true);
    if (r != null && !r.ok) return _refused(taskId, r);
    _local(taskId, (x) => x.copyWith(stage: 'tank_filled'));
    return null;
  }

  /// Tanker: the litres discharged and the receiver; then ends the trip.
  Future<String?> tankDischarged(String taskId, {required int litres, required String receivedBy}) async {
    final r = await _syncOp(taskId, {'type': 'milestone', 'code': 'tank_discharged', 'litres': litres, 'received_by': receivedBy}, wait: true);
    if (r != null && !r.ok) return _refused(taskId, r);
    _local(taskId, (x) => x.copyWith(status: 'completed', stage: 'tank_discharged'));
    await _syncOp(taskId, {'type': 'task_status', 'to_status': 'completed'});
    return null;
  }

  /// Container leg: picked up with the number read on the box (checked by the server) and the seal; checked online at once.
  Future<String?> containerPicked(String taskId, {required String containerNo, String? sealNo}) async {
    final r = await _syncOp(taskId, {'type': 'milestone', 'code': 'ctr_picked', 'container_no': containerNo, 'seal_no': ?sealNo}, wait: true);
    if (r != null && !r.ok) return _refused(taskId, r);
    _local(taskId, (x) => x.copyWith(stage: 'ctr_picked'));
    return null;
  }

  /// Container leg: dropped with the receiver's name or the gate receipt; then ends the leg.
  Future<String?> containerDropped(String taskId, {String? receivedBy, String? gateRef}) async {
    final r = await _syncOp(taskId, {'type': 'milestone', 'code': 'ctr_dropped', 'received_by': ?receivedBy, 'gate_ref': ?gateRef}, wait: true);
    if (r != null && !r.ok) return _refused(taskId, r);
    _local(taskId, (x) => x.copyWith(status: 'completed', stage: 'ctr_dropped'));
    await _syncOp(taskId, {'type': 'task_status', 'to_status': 'completed'});
    return null;
  }

  /// Move: unloaded at the new home with the receiver's name (and any damage noted); checked online at once, then ends the move.
  Future<String?> moveDone(String taskId, {required String receivedBy, String? note}) async {
    final r = await _syncOp(taskId, {'type': 'milestone', 'code': 'unloaded', 'received_by': receivedBy, 'note': ?note}, wait: true);
    if (r != null && !r.ok) return _refused(taskId, r);
    _local(taskId, (x) => x.copyWith(status: 'completed', stage: 'unloaded'));
    await _syncOp(taskId, {'type': 'task_status', 'to_status': 'completed'});
    return null;
  }

  /// Rental car: handed over to the renter (odometer, fuel, the renter's name) or taken back; checked online at once, then ends the task.
  Future<String?> rentalStep(String taskId, {required bool collect, required int odometerKm, int? fuel, String? receivedBy}) async {
    final code = collect ? 'collected' : 'handover';
    final r = await _syncOp(taskId, {'type': 'milestone', 'code': code, 'odometer_km': odometerKm, 'fuel': ?fuel, 'received_by': ?receivedBy}, wait: true);
    if (r != null && !r.ok) return _refused(taskId, r);
    _local(taskId, (x) => x.copyWith(status: 'completed', stage: code));
    await _syncOp(taskId, {'type': 'task_status', 'to_status': 'completed'});
    return null;
  }

  /// Distribution route: the driver checked the load list (with the odometer) before leaving.
  Future<String?> loadChecked(String routeId, {int? odometerKm}) async {
    final r = await _syncOp(routeId, {'type': 'milestone', 'code': 'load_checked', 'odometer_km': ?odometerKm}, wait: true);
    if (r != null && !r.ok) return _refused(routeId, r);
    _local(routeId, (x) => x.copyWith(stage: 'load_checked'));
    return null;
  }

  /// Leaving the depot opens the route's stops (the server does the same when the op arrives).
  Future<void> depart(String routeId) async {
    final ref = task(routeId)?.routeRef;
    tasks = [for (final t in tasks) t.isStop && t.routeRef == ref && t.status == 'assigned' ? t.copyWith(status: 'accepted') : t];
    await setStatus(routeId, 'in_progress');
  }

  /// A stop: delivered and returned quantities, the cash for a cash customer, who received. Online the server answers at once.
  Future<String?> stopProof(String taskId, {required Map<String, double> delivered, Map<String, double> returned = const {}, Map<String, double> damaged = const {}, String? cash, String? receivedBy}) async {
    final r = await _syncOp(taskId, {'type': 'stop', 'delivered': delivered, if (returned.isNotEmpty) 'returned': returned, if (damaged.isNotEmpty) 'damaged': damaged, 'cash_collected': ?cash, 'received_by': ?receivedBy}, wait: true);
    if (r != null && !r.ok) return _refused(taskId, r);
    _local(taskId, (x) => x.copyWith(status: 'completed'));
    return null;
  }

  /// The stop could not be served (shop closed, refused...).
  Future<String?> stopClosed(String taskId, String reason, {String? note}) async {
    final r = await _syncOp(taskId, {'type': 'stop', 'closed_reason': reason, 'note': ?note}, wait: true);
    if (r != null && !r.ok) return _refused(taskId, r);
    _local(taskId, (x) => x.copyWith(status: 'failed'));
    return null;
  }

  /// Back at the depot after the last stop: the odometer closes the route's distance and the route ends.
  Future<String?> routeBack(String routeId, {int? odometerKm}) async {
    final r = await _syncOp(routeId, {'type': 'milestone', 'code': 'route_back', 'odometer_km': ?odometerKm}, wait: true);
    if (r != null && !r.ok) return _refused(routeId, r);
    _local(routeId, (x) => x.copyWith(status: 'completed', stage: 'route_back'));
    await _syncOp(routeId, {'type': 'task_status', 'to_status': 'completed'});
    return null;
  }

  String _refused(String taskId, OpResult r) {
    queue.problems.removeWhere((p) => p.taskId == taskId && p.reason == r.reason);
    notifyListeners();
    return rejectReasons[r.reason] ?? r.reason ?? 'رُفض الطلب';
  }

  /// Checks the recipient's PIN with the server when online (so a wrong PIN is known at once).
  /// Offline it is queued and checked when the phone reconnects. Returns null when accepted or queued.
  Future<String?> provePin(String taskId, String pin) async {
    final r = await _syncOp(taskId, {'type': 'pod', 'method': 'pin', 'pin': pin}, wait: true);
    if (r != null && !r.ok) {
      queue.problems.removeWhere((p) => p.taskId == taskId && p.reason == r.reason);
      notifyListeners();
      return rejectReasons[r.reason] ?? r.reason ?? 'رُفض الرمز';
    }
    _local(taskId, (t) => t.copyWith(hasProof: true));
    return null;
  }

  Future<void> provePhoto(String taskId, Uint8List jpeg, {String? recipientName}) async {
    await queue.add({
      'kind': 'photo', 'task_id': taskId, 'upload_op': newOpId(), 'pod_op': newOpId(),
      'b64': base64Encode(jpeg), 'content_type': 'image/jpeg', 'recipient_name': recipientName, 'occurred_at': nowIso(),
    });
    _local(taskId, (t) => t.copyWith(hasProof: true));
    unawaited(queue.flush());
  }

  /// The site engineer signs the concrete delivery ticket: poured and returned m³, with an optional photo of the
  /// signature or paper ticket. Online without a photo the server answers at once, so a refusal shows on the screen.
  Future<String?> signTicket(String taskId, {required double poured, required double returned, required String signedBy, Uint8List? jpeg}) async {
    final fields = {'poured_m3': poured, 'returned_m3': returned, 'signed_by': signedBy};
    if (jpeg != null) {
      await queue.add({
        'kind': 'photo', 'task_id': taskId, 'upload_op': newOpId(), 'pod_op': newOpId(), 'then': 'ticket', 'fields': fields,
        'b64': base64Encode(jpeg), 'content_type': 'image/jpeg', 'occurred_at': nowIso(),
      });
      _local(taskId, (t) => t.copyWith(hasProof: true));
      unawaited(queue.flush());
      return null;
    }
    final r = await _syncOp(taskId, {'type': 'ticket', ...fields}, wait: true);
    if (r != null && !r.ok) {
      queue.problems.removeWhere((p) => p.taskId == taskId && p.reason == r.reason);
      notifyListeners();
      return rejectReasons[r.reason] ?? r.reason ?? 'رُفضت التذكرة';
    }
    _local(taskId, (t) => t.copyWith(hasProof: true));
    return null;
  }

  Future<void> collectCod(String taskId, int fils) async {
    await queue.add({'kind': 'cod', 'task_id': taskId, 'body': {'client_op_id': newOpId(), 'task_id': taskId, 'amount': filsToMoney(fils), 'collected_at': nowIso()}});
  }

  void dismissProblems() {
    queue.problems.clear();
    notifyListeners();
  }
}
