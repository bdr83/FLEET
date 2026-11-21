import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:geolocator/geolocator.dart';
import 'api.dart';
import 'config.dart';
import 'queue.dart';

/// GPS during an open shift only (decision D6: no tracking off shift). Points are buffered on the phone
/// and sent in batches; the server keeps only points inside the driver's tracked shift.
class Tracker {
  Tracker(this.api, this.store);
  final Api api;
  final QueueStore store; // reuses the queue storage for the point buffer
  StreamSubscription<Position>? _sub;
  Timer? _beat;
  List<Map<String, dynamic>> _buffer = [];
  DateTime _last = DateTime.fromMillisecondsSinceEpoch(0);
  String? lastError;
  bool get running => _sub != null;

  Future<void> init() async => _buffer = await store.load();

  /// Asks for permission when needed. Returns an Arabic message when tracking cannot start.
  Future<String?> start() async {
    if (_sub != null) return null;
    if (!await Geolocator.isLocationServiceEnabled()) return lastError = 'خدمة الموقع مغلقة في الجهاز';
    var p = await Geolocator.checkPermission();
    if (p == LocationPermission.denied) p = await Geolocator.requestPermission();
    if (p == LocationPermission.denied || p == LocationPermission.deniedForever) {
      return lastError = 'لم يُسمح للتطبيق بالموقع. فعّله من إعدادات الجهاز';
    }
    final settings = switch (defaultTargetPlatform) {
      _ when kIsWeb => const LocationSettings(accuracy: LocationAccuracy.high, distanceFilter: gpsDistanceFilterM),
      TargetPlatform.android => AndroidSettings(
          accuracy: LocationAccuracy.high,
          distanceFilter: gpsDistanceFilterM,
          intervalDuration: gpsMinInterval,
          // keeps tracking while the screen is off, with a visible notification as Android requires
          foregroundNotificationConfig: const ForegroundNotificationConfig(
            notificationTitle: 'الوردية مفتوحة',
            notificationText: 'يُشارك موقعك مع المكتب حتى تنهي الوردية',
            enableWakeLock: true,
          ),
        ),
      TargetPlatform.iOS => AppleSettings(
          accuracy: LocationAccuracy.high,
          distanceFilter: gpsDistanceFilterM,
          activityType: ActivityType.automotiveNavigation,
          pauseLocationUpdatesAutomatically: false,
          showBackgroundLocationIndicator: true,
          allowBackgroundLocationUpdates: true,
        ),
      _ => const LocationSettings(accuracy: LocationAccuracy.high, distanceFilter: gpsDistanceFilterM),
    };
    _sub = Geolocator.getPositionStream(locationSettings: settings).listen(_onPoint, onError: (_) {});
    _beat = Timer.periodic(const Duration(seconds: 30), (_) => _heartbeat());
    unawaited(_heartbeat()); // a first point now, inside the shift that just started
    lastError = null;
    return null;
  }

  Future<void> stop() async {
    _beat?.cancel();
    _beat = null;
    await _sub?.cancel();
    _sub = null;
    await flush();
  }

  /// Current position once (used to tag stages with a location). Null if unavailable within a few seconds.
  Future<Position?> current() async {
    try {
      return await Geolocator.getCurrentPosition(locationSettings: const LocationSettings(accuracy: LocationAccuracy.high))
          .timeout(const Duration(seconds: 3));
    } catch (_) {
      try {
        return await Geolocator.getLastKnownPosition(); // not supported on web: throws
      } catch (_) {
        return null;
      }
    }
  }

  Future<void> _heartbeat() async {
    if (DateTime.now().difference(_last) < gpsHeartbeat && _last.year > 2000) return;
    final p = await current();
    if (p != null && _sub != null) _onPoint(p, at: DateTime.now());
  }

  /// [at] overrides the fix time for heartbeat points, whose fix may be a cached one taken before the shift.
  void _onPoint(Position p, {DateTime? at}) {
    final when = at ?? p.timestamp;
    if (when.difference(_last) < gpsMinInterval) return;
    _last = when;
    _buffer.add({
      'recorded_at': when.toUtc().toIso8601String(),
      'lat': p.latitude,
      'lng': p.longitude,
      if (p.accuracy > 0) 'accuracy_m': double.parse(p.accuracy.toStringAsFixed(1)),
      if (p.speed >= 0 && p.speed <= 150) 'speed_mps': double.parse(p.speed.toStringAsFixed(1)),
      if (p.heading >= 0 && p.heading <= 360) 'heading': double.parse(p.heading.toStringAsFixed(0)),
      'source': 'fg',
    });
    if (_buffer.length > 5000) _buffer.removeRange(0, _buffer.length - 5000); // a week offline at most
    unawaited(store.save(_buffer));
  }

  Future<void> flush() async {
    while (_buffer.isNotEmpty) {
      final batch = _buffer.take(500).toList();
      try {
        await api.post('/v1/driver/locations', {'points': batch});
      } on ApiException catch (e) {
        if (e.isNetwork || e.status >= 500 || e.status == 401) return;
        // a bad batch must not block tracking forever
      }
      _buffer.removeRange(0, batch.length);
      await store.save(_buffer);
    }
  }
}
