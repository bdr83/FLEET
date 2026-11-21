import 'package:flutter_test/flutter_test.dart';
import 'package:fleet_driver/core/models.dart';

DriverTask task(String status, {String? stage, String pack = 'delivery@1', Map<String, dynamic>? attrs}) =>
    DriverTask(id: 't', status: status, sectorPack: pack, attributes: attrs ?? {}, version: 1, stage: stage);

void main() {
  test('Kuwaiti address line', () {
    expect(addressLine({'area': 'السالمية', 'block': '5', 'street': '10', 'house': '12'}), 'السالمية، ق 5، ش 10، م 12');
    expect(addressLine({}), isNull);
    expect(task('assigned', attrs: {'address': 'نص حر'}).address, 'نص حر');
  });

  test('money in fils', () {
    expect(moneyToFils('7.5'), 7500);
    expect(moneyToFils('7.250'), 7250);
    expect(moneyToFils(3), 3000);
    expect(moneyToFils('abc'), 0);
    expect(moneyToFils(null), 0);
    expect(filsToMoney(7050), '7.050');
  });

  test('recipient and navigation target', () {
    final t = task('accepted', attrs: {
      'recipient': {'name': 'أحمد', 'phone': '+96550000001'},
      'pickup': {'area': 'الشويخ', 'lat': 29.35, 'lng': 47.93},
      'dropoff': {'area': 'السالمية', 'lat': 29.33, 'lng': 48.07},
      'cod_amount': '7.500',
    });
    expect(t.recipientPhone, '+96550000001');
    expect(t.codFils, 7500);
    expect(t.target, (lat: 29.35, lng: 47.93)); // to the pickup first
    expect(t.copyWith(stage: 'picked_up').target, (lat: 29.33, lng: 48.07));
  });

  test('delivery actions follow the stages', () {
    expect(nextActions(task('assigned')), [TaskAction.accept]);
    expect(nextActions(task('accepted')), [TaskAction.atPickup, TaskAction.pickedUp]);
    expect(nextActions(task('accepted', stage: 'at_pickup')), [TaskAction.pickedUp]);
    expect(nextActions(task('accepted', stage: 'picked_up')), [TaskAction.start]);
    expect(nextActions(task('in_progress', stage: 'picked_up')), [TaskAction.atDropoff, TaskAction.deliver, TaskAction.fail]);
    expect(nextActions(task('in_progress', stage: 'at_dropoff')), [TaskAction.deliver, TaskAction.fail]);
    expect(nextActions(task('failed')), [TaskAction.returned]);
    expect(nextActions(task('failed', stage: 'returned_to_sender')), isEmpty);
  });

  test('other sectors keep the simple flow', () {
    expect(nextActions(task('accepted', pack: 'concrete@1')), [TaskAction.start]);
    expect(nextActions(task('in_progress', pack: 'concrete@1')), [TaskAction.complete, TaskAction.fail]);
    expect(nextActions(task('failed', pack: 'concrete@1')), isEmpty);
  });

  test('every server rejection reason has Arabic text', () {
    for (final r in ['wrong_pin', 'pin_locked', 'proof_required', 'invalid_transition', 'not_assigned_to_you', 'reason_required']) {
      expect(rejectReasons[r], isNotNull);
    }
    expect(failReasons.keys, ['recipient_absent', 'wrong_address', 'recipient_refused', 'unreachable', 'damaged', 'cod_not_paid', 'customer_canceled', 'other']);
  });
}
