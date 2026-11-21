import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:fleet_driver/core/api.dart';
import 'package:fleet_driver/core/queue.dart';

class MemTokens extends TokenStore {
  ({String access, String refresh})? t;
  @override
  Future<({String access, String refresh})?> read() async => t;
  @override
  Future<void> write(String access, String refresh) async => t = (access: access, refresh: refresh);
  @override
  Future<void> clear() async => t = null;
}

Map<String, dynamic> syncEntry(String id, String taskId, Map<String, dynamic> op) =>
    {'kind': 'sync', 'task_id': taskId, 'op': {'client_op_id': id, 'task_id': taskId, 'occurred_at': '2026-11-21T10:00:00Z', ...op}};

void main() {
  late List<http.Request> calls;
  late bool online;
  late Api api;
  late MemoryQueueStore store;

  setUp(() async {
    calls = [];
    online = true;
    final client = MockClient((req) async {
      if (!online) throw http.ClientException('offline');
      calls.add(req);
      if (req.url.path == '/v1/driver/sync') {
        final ops = (jsonDecode(req.body)['ops'] as List);
        return http.Response(jsonEncode({
          'results': [
            for (final o in ops)
              o['pin'] == '0000'
                  ? {'client_op_id': o['client_op_id'], 'result': 'rejected', 'reason': 'wrong_pin'}
                  : {'client_op_id': o['client_op_id'], 'result': 'applied', if (o['type'] == 'pod') 'verified': o['method'] == 'pin'}
          ]
        }), 200);
      }
      if (req.url.path == '/v1/driver/files') return http.Response(jsonEncode({'file_key': 'file:abc'}), 201);
      if (req.url.path == '/v1/driver/cod') return http.Response('{"message":"amount must be more than 0"}', 400);
      if (req.url.path == '/v1/auth/refresh') return http.Response(jsonEncode({'access_token': 'a2', 'refresh_token': 'r2'}), 200);
      return http.Response('{}', 404);
    });
    api = Api(client: client, tokens: MemTokens(), baseUrl: 'http://api');
    await api.setSession('a1', 'r1');
    store = MemoryQueueStore();
  });

  test('keeps actions while offline and sends them in order, batched, when back online', () async {
    final q = OpQueue(api, store);
    await q.init();
    online = false;
    await q.add(syncEntry('1', 't1', {'type': 'task_status', 'to_status': 'accepted'}));
    await q.add(syncEntry('2', 't1', {'type': 'milestone', 'code': 'picked_up'}));
    await q.flush();
    expect(q.pending, 2);
    expect(store.data.length, 2); // survives an app restart

    final q2 = OpQueue(api, store);
    await q2.init();
    online = true;
    await q2.flush();
    expect(q2.pending, 0);
    expect(calls.length, 1);
    final ops = jsonDecode(calls.single.body)['ops'] as List;
    expect(ops.map((o) => o['client_op_id']), ['1', '2']);
    expect(q2.resultOf('2')!.ok, isTrue);
  });

  test('a rejected op is reported and does not block the rest', () async {
    final q = OpQueue(api, store);
    await q.add(syncEntry('p', 't1', {'type': 'pod', 'method': 'pin', 'pin': '0000'}));
    await q.add(syncEntry('c', 't1', {'type': 'task_status', 'to_status': 'accepted'}));
    await q.flush();
    expect(q.pending, 0);
    expect(q.resultOf('p')!.reason, 'wrong_pin');
    expect(q.problems.single.reason, 'wrong_pin');
    expect(q.resultOf('c')!.ok, isTrue);
  });

  test('a photo is uploaded first, then its proof op is sent before the completion', () async {
    final q = OpQueue(api, store);
    await q.add({'kind': 'photo', 'task_id': 't1', 'upload_op': 'u1', 'pod_op': 'p1', 'b64': base64Encode([0xff, 0xd8, 0xff, 1]), 'content_type': 'image/jpeg', 'occurred_at': '2026-11-21T10:00:00Z'});
    await q.add(syncEntry('done', 't1', {'type': 'task_status', 'to_status': 'completed'}));
    await q.flush();
    expect(calls.map((c) => c.url.path), ['/v1/driver/files', '/v1/driver/sync']);
    expect(calls.first.url.queryParameters['client_op_id'], 'u1');
    expect(calls.first.headers['content-type'], 'image/jpeg');
    final ops = jsonDecode(calls.last.body)['ops'] as List;
    expect(ops.map((o) => o['type']), ['pod', 'task_status']);
    expect(ops.first['file_key'], 'file:abc');
  });

  test('a bad request is dropped with a problem, not retried forever', () async {
    final q = OpQueue(api, store);
    await q.add({'kind': 'cod', 'task_id': 't1', 'body': {'client_op_id': 'k', 'task_id': 't1', 'amount': '0.000'}});
    await q.flush();
    expect(q.pending, 0);
    expect(q.problems.single.reason, contains('amount'));
  });

  test('refreshes the access token once on 401', () async {
    var n = 0;
    final client = MockClient((req) async {
      if (req.url.path == '/v1/auth/refresh') return http.Response(jsonEncode({'access_token': 'a2', 'refresh_token': 'r2'}), 200);
      n++;
      return req.headers['authorization'] == 'Bearer a2' ? http.Response('{"ok":true}', 200) : http.Response('{}', 401);
    });
    final a = Api(client: client, tokens: MemTokens(), baseUrl: 'http://api');
    await a.setSession('old', 'r1');
    expect((await a.get('/v1/driver/me'))['ok'], isTrue);
    expect(n, 2);
  });
}
