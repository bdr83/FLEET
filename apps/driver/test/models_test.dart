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

  group('concrete loads', () {
    DriverTask load(String status, {String? stage, bool proof = false}) => DriverTask(
        id: 'c', status: status, sectorPack: 'concrete@1', version: 1, stage: stage, hasProof: proof,
        attributes: {'address': 'برج الريم، الشرق', 'volume_m3': 9, 'mix_code': 'C35', 'dropoff': {'lat': 29.37, 'lng': 47.99, 'contact_name': 'م. خالد'}},
        ticket: {'ticket_no': 'RM-1-1', 'volume_m3': '9.00', 'batched_at': null, 'signed': false, 'site_ready': false});

    test('the mixer trip goes loaded → out → site → pour → ticket → done', () {
      expect(nextActions(load('assigned')), [TaskAction.accept]);
      expect(nextActions(load('accepted')), [TaskAction.loaded]);
      expect(nextActions(load('accepted', stage: 'loaded')), [TaskAction.start]);
      expect(nextActions(load('in_progress', stage: 'loaded')), [TaskAction.atSite, TaskAction.fail]);
      expect(nextActions(load('in_progress', stage: 'at_site')), [TaskAction.pourStart, TaskAction.fail]);
      expect(nextActions(load('in_progress', stage: 'pour_start')), [TaskAction.pourEnd]);
      expect(nextActions(load('in_progress', stage: 'pour_end')), [TaskAction.ticket]);
      expect(nextActions(load('in_progress', stage: 'pour_end', proof: true)), [TaskAction.complete]);
      expect(actionLabel(load('accepted', stage: 'loaded'), TaskAction.start), 'انطلقت إلى الموقع');
      expect(actionLabel(task('accepted', stage: 'picked_up'), TaskAction.start), 'بدء التوصيل');
    });
    test('load details and site', () {
      final t = load('accepted');
      expect(t.ticketNo, 'RM-1-1');
      expect(t.volumeM3, 9.0);
      expect(t.siteReady, isFalse);
      expect(t.siteContact, 'م. خالد');
      expect(t.address, 'برج الريم، الشرق');
      expect(t.target, (lat: 29.37, lng: 47.99));
    });
    test('ticket quantities', () {
      expect(parseM3('8.5'), 8.5);
      expect(parseM3('٨٫٥'), 8.5);
      expect(parseM3('8,25'), 8.25);
      expect(parseM3('8.555'), isNull);
      expect(parseM3('abc'), isNull);
      expect(ticketError(9, 8.5, 0.5, 'م. خالد'), isNull);
      expect(ticketError(9, 8.5, 1, 'م. خالد'), isNotNull);
      expect(ticketError(9, null, 0, 'x'), isNotNull);
      expect(ticketError(9, 9, 0, ' '), isNotNull);
    });
  });

  group('driver supply shifts', () {
    DriverTask shift(String status, {String? stage, DateTime? from}) => DriverTask(
        id: 's', status: status, sectorPack: 'staffing@1', version: 1, stage: stage, windowFrom: from,
        attributes: {'shift': '08:00–17:00', 'work_date': '2026-11-22', 'request_ref': 'SR-1', 'address': 'مستودع الري، الري، ق 1',
          'dropoff': {'name': 'مستودع الري', 'area': 'الري', 'lat': 29.3, 'lng': 47.93, 'contact_name': 'أبو محمد', 'contact_phone': '+96550000011'}});
    test('one tap to check in, one to check out', () {
      expect(nextActions(shift('assigned')), [TaskAction.checkIn]);
      expect(nextActions(shift('accepted')), [TaskAction.checkIn]);
      expect(nextActions(shift('in_progress', stage: 'check_in')), [TaskAction.checkOut, TaskAction.fail]);
      expect(nextActions(shift('in_progress', stage: 'check_out')), [TaskAction.complete]);
      expect(nextActions(shift('completed')), isEmpty);
      expect(actionLabel(shift('assigned'), TaskAction.checkIn), 'تسجيل الحضور');
      // check-in opens two hours before the shift
      final at = DateTime.utc(2026, 11, 23, 5);
      expect(nextActions(shift('assigned', from: at), now: at.subtract(const Duration(hours: 3))), isEmpty);
      expect(nextActions(shift('assigned', from: at), now: at.subtract(const Duration(minutes: 90))), [TaskAction.checkIn]);
      expect(actionLabel(shift('in_progress'), TaskAction.checkOut), 'تسجيل الانصراف');
    });
    test('shift details, site and reasons', () {
      final t = shift('assigned');
      expect(t.isStaffing, isTrue);
      expect(t.shift, '08:00–17:00');
      expect(t.address, 'مستودع الري، الري، ق 1');
      expect(t.siteContact, 'أبو محمد');
      expect(t.target, (lat: 29.3, lng: 47.93));
      expect(failReasonsFor(t), staffingFailReasons);
      expect(stageLabels['check_in'], isNotNull);
    });
  });

  group('in-house trips', () {
    DriverTask trip(String status, {String? stage}) => DriverTask(
        id: 'i', status: status, sectorPack: 'internal@1', version: 1, stage: stage,
        attributes: {'request_ref': 'VR-7', 'purpose': 'نقل وفد', 'address': 'الأحمدي', 'department': 'المبيعات', 'requester': 'سارة', 'requester_phone': '+96550000022', 'passengers': 6});
    test('accept, take the vehicle, bring it back', () {
      expect(nextActions(trip('assigned')), [TaskAction.accept]);
      expect(nextActions(trip('accepted')), [TaskAction.vehicleOut]);
      expect(nextActions(trip('in_progress', stage: 'vehicle_out')), [TaskAction.vehicleBack, TaskAction.fail]);
      expect(nextActions(trip('in_progress', stage: 'vehicle_back')), [TaskAction.complete]);
      expect(nextActions(trip('completed')), isEmpty);
      expect(actionLabel(trip('accepted'), TaskAction.vehicleOut), 'استلمت المركبة');
      expect(actionLabel(trip('in_progress'), TaskAction.vehicleBack), 'أرجعت المركبة');
      expect(actionLabel(trip('assigned'), TaskAction.accept), 'قبول المشوار');
    });
    test('trip details and reasons', () {
      final t = trip('assigned');
      expect(t.isInternal, isTrue);
      expect(t.address, 'الأحمدي');
      expect((t.purpose, t.department, t.requester, t.passengers), ('نقل وفد', 'المبيعات', 'سارة', 6));
      expect(failReasonsFor(t), internalFailReasons);
      expect(stageLabels['vehicle_out'], isNotNull);
      expect(rejectReasons['odometer_too_low'], isNotNull);
      expect([fuelLabel(0), fuelLabel(4), fuelLabel(8)], ['فارغ', '4/8', 'ممتلئ']);
    });
  });

  group('distribution routes', () {
    DriverTask route(String status, {String? stage}) => DriverTask(id: 'r', status: status, sectorPack: 'distribution@1', version: 1, stage: stage,
        attributes: {'kind': 'route', 'route_ref': 'DR-1', 'stops': 2, 'load': [{'sku': 'MLK', 'name': 'حليب', 'qty': 30}, {'sku': 'LBN', 'name': 'لبن', 'qty': 2.5}]});
    DriverTask stop(String status, {bool cash = false}) => DriverTask(id: 's', status: status, sectorPack: 'distribution@1', version: 1,
        attributes: {'kind': 'stop', 'route_ref': 'DR-1', 'seq': 2, 'name': 'بقالة', 'payment': cash ? 'cash' : 'credit', 'address': 'الرميثية',
          'items': [{'sku': 'MLK', 'name': 'حليب', 'qty': 10, 'price': '0.350'}, {'sku': 'LBN', 'name': 'لبن', 'qty': 4, 'price': '0.250'}]});
    test('route: accept, check the load, leave, come back', () {
      expect(nextActions(route('assigned')), [TaskAction.accept]);
      expect(nextActions(route('accepted')), [TaskAction.loadChecked]);
      expect(nextActions(route('accepted', stage: 'load_checked')), [TaskAction.depart]);
      expect(nextActions(route('in_progress', stage: 'load_checked')), [TaskAction.routeBack]);
      expect(nextActions(route('in_progress', stage: 'route_back')), [TaskAction.complete]);
      expect(actionLabel(route('accepted'), TaskAction.loadChecked), 'راجعت الحمولة');
      final r = route('assigned');
      expect((r.isRoute, r.isStop, r.stopsCount), (true, false, 2));
      expect(r.loadList.map((i) => qtyText(i.qty)).toList(), ['30', '2.5']);
    });
    test('stop: opens after departure, value of what was delivered', () {
      expect(nextActions(stop('assigned')), isEmpty);
      expect(nextActions(stop('accepted')), [TaskAction.stopDeliver, TaskAction.fail]);
      final s = stop('accepted', cash: true);
      expect((s.isStop, s.payCash, s.seq, s.address), (true, true, 2, 'الرميثية'));
      expect(distValueFils(s.distItems, {'MLK': 10, 'LBN': 2}), 3500 + 500);
      expect(failReasonsFor(s), distFailReasons);
      expect(rejectReasons['stops_open'], isNotNull);
    });
  });

  group('cold chain', () {
    test('cold route range and stop expiry', () {
      final r = task('accepted', pack: 'distribution@1', attrs: {'kind': 'route', 'temp_class': 'frozen', 'temp_min': -25, 'temp_max': -18});
      expect((r.isCold, r.tempMin, r.tempMax), (true, -25.0, -18.0));
      expect(task('accepted', pack: 'distribution@1', attrs: {'kind': 'route', 'temp_class': 'ambient'}).isCold, false);
      expect(task('accepted', pack: 'distribution@1', attrs: {'kind': 'route'}).isCold, false);
      final s = task('accepted', pack: 'distribution@1', attrs: {'kind': 'stop', 'items': [{'sku': 'MLK', 'name': 'حليب', 'qty': 1, 'price': '0.350', 'expiry': '2026-11-23'}]});
      expect(s.distItems.single.expiry, '2026-11-23');
      expect(distFailReasons.keys, containsAll(['temp_out_of_range', 'expired', 'late_window']));
    });
    test('typed temperature', () {
      expect(parseCelsius('4.5'), 4.5);
      expect(parseCelsius('-18'), -18.0);
      expect(parseCelsius('٣٫٥'), 3.5);
      expect(parseCelsius('−20,5'), -20.5);
      expect(parseCelsius('99'), isNull);
      expect(parseCelsius('4.55'), isNull);
      expect(parseCelsius(''), isNull);
    });
  });

  group('freight trips', () {
    DriverTask trip(String status, {String? stage}) => DriverTask(
        id: 'f', status: status, sectorPack: 'freight@1', version: 1, stage: stage,
        attributes: {'address': 'مشروع المطلاع، المطلاع', 'pickup_address': 'مصنع الحديد، الشعيبة', 'pickup': {'lat': 29.03, 'lng': 48.1}, 'dropoff': {'lat': 29.6, 'lng': 47.7}},
        freight: {'waybill_no': 'WB-1', 'cargo': {'description': 'حديد', 'weight_kg': 18000}, 'trailer_plate': 'TL-1'});

    test('the trip goes pickup → loaded → road → drop-off → unloaded → done', () {
      expect(nextActions(trip('assigned')), [TaskAction.accept]);
      expect(nextActions(trip('accepted')), [TaskAction.atPickup]);
      expect(nextActions(trip('accepted', stage: 'at_pickup')), [TaskAction.loaded]);
      expect(nextActions(trip('accepted', stage: 'loaded')), [TaskAction.start]);
      expect(nextActions(trip('in_progress', stage: 'loaded')), [TaskAction.atDropoff, TaskAction.fail]);
      expect(nextActions(trip('in_progress', stage: 'at_dropoff')), [TaskAction.unloaded, TaskAction.fail]);
      expect(nextActions(trip('in_progress', stage: 'unloaded')), [TaskAction.complete]);
      expect(actionLabel(trip('in_progress', stage: 'at_dropoff'), TaskAction.unloaded), 'تم التفريغ والتسليم');
      expect(failReasonsFor(trip('in_progress')), freightFailReasons);
    });
    test('waybill, places and navigation target', () {
      final t = trip('accepted');
      expect(t.waybillNo, 'WB-1');
      expect(t.cargo['weight_kg'], 18000);
      expect(t.address, 'مشروع المطلاع، المطلاع');
      expect(t.pickupLine, 'مصنع الحديد، الشعيبة');
      expect(t.target, (lat: 29.03, lng: 48.1));
      expect(trip('in_progress', stage: 'loaded').target, (lat: 29.6, lng: 47.7));
      // without its waybill a freight@1 task keeps the simple flow
      expect(DriverTask(id: 'x', status: 'accepted', sectorPack: 'freight@1', version: 1, attributes: const {}).isFreight, isFalse);
    });
  });
}
