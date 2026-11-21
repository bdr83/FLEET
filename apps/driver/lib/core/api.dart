import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'config.dart';

class ApiException implements Exception {
  ApiException(this.status, this.message);
  final int status;
  final String message;
  /// No answer from the server (offline, timeout): the action can be queued and retried.
  bool get isNetwork => status == 0;
  @override
  String toString() => message;
}

/// Tokens live in the platform keystore (Keychain / Android Keystore), never in plain preferences.
class TokenStore {
  TokenStore([FlutterSecureStorage? s]) : _s = s ?? const FlutterSecureStorage();
  final FlutterSecureStorage _s;
  Future<({String access, String refresh})?> read() async {
    final a = await _s.read(key: 'access'), r = await _s.read(key: 'refresh');
    return a == null || r == null ? null : (access: a, refresh: r);
  }
  Future<void> write(String access, String refresh) async {
    await _s.write(key: 'access', value: access);
    await _s.write(key: 'refresh', value: refresh);
  }
  Future<void> clear() => _s.deleteAll();
}

/// Thin client for the fleet API. Refreshes the access token once on 401; a failed refresh signs the driver out.
class Api {
  Api({http.Client? client, TokenStore? tokens, this.baseUrl = apiUrl})
      : _http = client ?? http.Client(),
        tokens = tokens ?? TokenStore();
  final http.Client _http;
  final TokenStore tokens;
  final String baseUrl;
  String? _access, _refresh;
  void Function()? onSignedOut;

  bool get signedIn => _access != null;

  Future<bool> restore() async {
    final t = await tokens.read();
    if (t == null) return false;
    _access = t.access;
    _refresh = t.refresh;
    return true;
  }

  Future<void> setSession(String access, String refresh) async {
    _access = access;
    _refresh = refresh;
    await tokens.write(access, refresh);
  }

  Future<void> signOut() async {
    final r = _refresh;
    _access = null;
    _refresh = null;
    await tokens.clear();
    if (r != null) {
      try {
        await _send('POST', '/v1/auth/logout', body: {'refresh_token': r}, auth: false);
      } catch (_) {/* offline: the server token expires on its own */}
    }
  }

  Future<dynamic> get(String path) => _call('GET', path);
  Future<dynamic> post(String path, [Object? body]) => _call('POST', path, body: body ?? const {});

  /// Raw upload (proof photos).
  Future<dynamic> upload(String path, Uint8List bytes, String contentType) => _call('POST', path, raw: bytes, contentType: contentType);

  /// Calls without the session (login steps), optionally with a short-lived user token.
  Future<dynamic> postPublic(String path, Object body, {String? bearer}) => _send('POST', path, body: body, auth: false, bearer: bearer);

  Future<dynamic> _call(String method, String path, {Object? body, Uint8List? raw, String? contentType}) async {
    try {
      return await _send(method, path, body: body, raw: raw, contentType: contentType);
    } on ApiException catch (e) {
      if (e.status != 401 || _refresh == null) rethrow;
      if (!await _refreshTokens()) {
        await signOut();
        onSignedOut?.call();
        rethrow;
      }
      return _send(method, path, body: body, raw: raw, contentType: contentType);
    }
  }

  Future<bool> _refreshTokens() async {
    try {
      final r = await _send('POST', '/v1/auth/refresh', body: {'refresh_token': _refresh}, auth: false);
      await setSession(r['access_token'], r['refresh_token']);
      return true;
    } on ApiException catch (e) {
      if (e.isNetwork) rethrow;
      return false;
    }
  }

  Future<dynamic> _send(String method, String path,
      {Object? body, Uint8List? raw, String? contentType, bool auth = true, String? bearer}) async {
    final req = http.Request(method, Uri.parse('$baseUrl$path'));
    final token = bearer ?? (auth ? _access : null);
    if (token != null) req.headers['authorization'] = 'Bearer $token';
    if (raw != null) {
      req.headers['content-type'] = contentType!;
      req.bodyBytes = raw;
    } else if (body != null) {
      req.headers['content-type'] = 'application/json';
      req.body = jsonEncode(body);
    }
    http.Response res;
    try {
      res = await http.Response.fromStream(await _http.send(req).timeout(const Duration(seconds: 25)));
    } catch (_) {
      throw ApiException(0, 'لا يوجد اتصال بالخادم');
    }
    final data = res.body.isEmpty ? null : _json(res.body);
    if (res.statusCode >= 200 && res.statusCode < 300) return data;
    throw ApiException(res.statusCode, _message(res.statusCode, data));
  }

  static Object? _json(String s) {
    try {
      return jsonDecode(s);
    } catch (_) {
      return null;
    }
  }

  static String _message(int status, Object? data) {
    final m = data is Map ? data['message'] : null;
    final text = m is List ? m.join('، ') : m is String ? m : '';
    if (status == 401) return 'انتهت الجلسة، سجّل الدخول مرة أخرى';
    if (status == 403) return text.contains('worker') || text.contains('field worker') ? 'هذا الرقم غير مسجّل كسائق في الشركة' : 'ليست لديك صلاحية';
    if (status == 429) return 'محاولات كثيرة، انتظر قليلًا';
    if (status >= 500) return 'خطأ في الخادم، حاول لاحقًا';
    return text.isEmpty ? 'تعذّر تنفيذ الطلب' : text;
  }
}
