import 'dart:async';
import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import 'api.dart';

/// Where the queue is kept between app launches.
abstract class QueueStore {
  Future<List<Map<String, dynamic>>> load();
  Future<void> save(List<Map<String, dynamic>> entries);
}

class PrefsQueueStore implements QueueStore {
  PrefsQueueStore(this.key);
  final String key;
  @override
  Future<List<Map<String, dynamic>>> load() async {
    final s = (await SharedPreferences.getInstance()).getString(key);
    if (s == null) return [];
    return (jsonDecode(s) as List).map((e) => Map<String, dynamic>.from(e)).toList();
  }
  @override
  Future<void> save(List<Map<String, dynamic>> entries) async =>
      (await SharedPreferences.getInstance()).setString(key, jsonEncode(entries));
}

class MemoryQueueStore implements QueueStore {
  List<Map<String, dynamic>> data = [];
  @override
  Future<List<Map<String, dynamic>>> load() async => [...data];
  @override
  Future<void> save(List<Map<String, dynamic>> entries) async => data = [...entries];
}

/// One rejected action, shown to the driver until dismissed.
class Problem {
  Problem(this.taskId, this.reason, this.at);
  final String? taskId;
  final String reason;
  final DateTime at;
}

/// Outcome of one queued action once the server answered.
class OpResult {
  OpResult(this.result, {this.reason, this.verified});
  final String result; // applied | duplicate | rejected
  final String? reason;
  final bool? verified;
  bool get ok => result != 'rejected';
}

/// Offline-first action queue. Every action carries a client_op_id, is kept on the phone until the
/// server answers, and is sent in order. The server ignores repeats, so re-sending after a lost answer is safe.
///
/// Kinds: sync (an op for /v1/driver/sync), cod (cash collected), photo (upload a photo, then its pod op, or its
/// ticket op when then = 'ticket').
class OpQueue {
  OpQueue(this.api, this.store);
  final Api api;
  final QueueStore store;
  List<Map<String, dynamic>> _entries = [];
  final problems = <Problem>[];
  final _results = <String, OpResult>{};
  Future<void>? _running;
  void Function()? onChange;

  int get pending => _entries.length;
  bool hasPendingFor(String taskId) => _entries.any((e) => e['task_id'] == taskId);

  Future<void> init() async => _entries = await store.load();

  Future<void> add(Map<String, dynamic> entry) async {
    _entries.add(entry);
    await store.save(_entries);
    onChange?.call();
  }

  OpResult? resultOf(String opId) => _results[opId];

  /// Sends everything it can. Stops at the first network failure and keeps the rest for later.
  Future<void> flush() => _running ??= _flush().whenComplete(() => _running = null);

  Future<void> _flush() async {
    while (_entries.isNotEmpty) {
      final head = _entries.first;
      try {
        if (head['kind'] == 'sync') {
          final batch = _entries.takeWhile((e) => e['kind'] == 'sync').take(200).toList();
          final r = await api.post('/v1/driver/sync', {'ops': batch.map((e) => e['op']).toList()});
          for (final x in (r['results'] as List)) {
            final res = OpResult(x['result'], reason: x['reason'], verified: x['verified']);
            _results[x['client_op_id']] = res;
            if (!res.ok) {
              final e = batch.firstWhere((b) => b['op']['client_op_id'] == x['client_op_id'], orElse: () => {});
              problems.add(Problem(e['task_id'], x['reason'] ?? 'rejected', DateTime.now()));
            }
          }
          _entries.removeRange(0, batch.length);
        } else if (head['kind'] == 'cod') {
          await api.post('/v1/driver/cod', head['body']);
          _results[head['body']['client_op_id']] = OpResult('applied');
          _entries.removeAt(0);
        } else if (head['kind'] == 'photo') {
          final up = await api.upload('/v1/driver/files?purpose=pod&client_op_id=${head['upload_op']}',
              base64Decode(head['b64']), head['content_type']);
          // the pod op takes the photo's place in the queue, keeping the order (pod before "completed")
          _entries[0] = head['then'] == 'ticket' ? {
            'kind': 'sync',
            'task_id': head['task_id'],
            'op': {
              'type': 'ticket',
              'client_op_id': head['pod_op'],
              'task_id': head['task_id'],
              ...Map<String, dynamic>.from(head['fields'] as Map),
              'file_key': up['file_key'],
              'occurred_at': head['occurred_at'],
            },
          } : {
            'kind': 'sync',
            'task_id': head['task_id'],
            'op': {
              'type': 'pod',
              'client_op_id': head['pod_op'],
              'task_id': head['task_id'],
              'method': 'photo',
              'file_key': up['file_key'],
              if (head['recipient_name'] != null) 'recipient_name': head['recipient_name'],
              'occurred_at': head['occurred_at'],
            },
          };
        } else {
          _entries.removeAt(0); // unknown kind from an older app version
        }
      } on ApiException catch (e) {
        if (e.isNetwork || e.status == 401 || e.status >= 500) break; // try again later
        // the server refused this action for good (bad data): drop it and tell the driver
        problems.add(Problem(head['task_id'], e.message, DateTime.now()));
        final id = head['op']?['client_op_id'] ?? head['body']?['client_op_id'] ?? head['pod_op'];
        if (id != null) _results[id] = OpResult('rejected', reason: e.message);
        _entries.removeAt(0);
      } finally {
        await store.save(_entries);
        onChange?.call();
      }
    }
  }
}
