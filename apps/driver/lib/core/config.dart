/// Build-time settings: flutter run --dart-define=API_URL=https://api.example.com
const apiUrl = String.fromEnvironment('API_URL', defaultValue: 'http://localhost:3000');

/// Shows the OTP code returned by a development API (OTP_DEV_ECHO=1). Never on in a store build.
const showDevCode = bool.fromEnvironment('SHOW_DEV_CODE', defaultValue: false);

/// How often queued actions and GPS points are sent when the app is open.
const flushEvery = Duration(seconds: 20);

/// GPS: a point every 25 m of movement, at most one per 10 s. [تخمين] tune with the pilot on battery use.
const gpsDistanceFilterM = 25;
const gpsMinInterval = Duration(seconds: 10);

/// A driver standing still sends no points (distance filter). A heartbeat point keeps "last seen" fresh so the
/// office map and auto-assignment (position_fresh_minutes) still count them. [تخمين]
const gpsHeartbeat = Duration(minutes: 2);
