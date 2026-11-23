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

  test('staff transport trip: stops, riders, marks and the simple flow', () {
    final base = task('assigned', pack: 'shuttle@1', attrs: {'kind': 'trip', 'direction': 'from_work', 'capacity': 3,
      'stops': [{'name': 'المصفاة', 'time': '16:00'}, {'name': 'السكن', 'area': 'المهبولة', 'time': '16:45'}]});
    final t = DriverTask(id: 't', status: 'assigned', sectorPack: 'shuttle@1', attributes: base.attributes, version: 1,
        shuttle: {'trip_id': 'x', 'riders': [{'id': 'a', 'name': 'أنيل', 'stop_seq': 2, 'event': 'boarded'}, {'id': 'b', 'name': 'محمد', 'stop_seq': 2}]});
    expect((t.isShuttle, t.toWork, t.capacity, t.shuttleStops.last.area, t.riders.length, t.boardedCount), (true, false, 3, 'المهبولة', 2, 1));
    final m = t.copyWith(shuttle: {...t.shuttle!, 'riders': [for (final r in t.riders) {...r.toJson(), 'event': 'boarded'}]});
    expect(m.boardedCount, 2);
    expect(nextActions(t), [TaskAction.accept]);
    expect(nextActions(t.copyWith(status: 'accepted')), [TaskAction.start]);
    expect(nextActions(t.copyWith(status: 'in_progress')), [TaskAction.complete, TaskAction.fail]);
    expect(actionLabel(t, TaskAction.start), 'انطلقت');
    expect(failReasonsFor(t), shuttleFailReasons);
  });

  test('hired machine: start and end work, labels, meter input', () {
    final t = task('assigned', pack: 'equipment@1', attrs: {'kind': 'hire_day', 'min_hours': 8, 'machine_type': 'crane'});
    expect((t.isEquipment, t.minHours), (true, 8.0));
    expect(nextActions(t), [TaskAction.accept]);
    expect(nextActions(t.copyWith(status: 'accepted')), [TaskAction.workStart]);
    expect(nextActions(t.copyWith(status: 'in_progress')), [TaskAction.workEnd, TaskAction.fail]);
    expect(actionLabel(t, TaskAction.workEnd), 'انتهى العمل');
    expect(failReasonsFor(t), equipmentFailReasons);
    expect(parseMeter('1520.5'), 1520.5);
    expect(parseMeter('١٥٢٠٫٥'), 1520.5);
    expect(parseMeter('12.55'), isNull);
    expect(parseMeter('-3'), isNull);
  });

  test('rental car: deliver with hand-over, collect, labels', () {
    final t = task('assigned', pack: 'rental@1', attrs: {'kind': 'deliver', 'rental_ref': 'RA-1', 'renter_name': 'فهد', 'address': 'السالمية، ق 10'});
    expect((t.isRental, t.isCollect, t.address), (true, false, 'السالمية، ق 10'));
    expect(nextActions(t), [TaskAction.accept]);
    expect(nextActions(t.copyWith(status: 'accepted')), [TaskAction.start]);
    expect(nextActions(t.copyWith(status: 'in_progress')), [TaskAction.handover, TaskAction.fail]);
    expect(nextActions(t.copyWith(status: 'in_progress', stage: 'handover')), [TaskAction.complete]);
    final c = task('in_progress', pack: 'rental@1', attrs: {'kind': 'collect'});
    expect(nextActions(c), [TaskAction.collected, TaskAction.fail]);
    expect(actionLabel(c, TaskAction.start), 'انطلقت لاستلام السيارة');
    expect(actionLabel(t, TaskAction.handover), 'سلّمت السيارة للعميل');
    expect(failReasonsFor(t), rentalFailReasons);
    expect(task('assigned', pack: 'rental@1', attrs: {'kind': 'rental'}).isRental, false);
  });

  test('service visit: arrive, result, labels, part quantities', () {
    final t = task('assigned', pack: 'service@1', attrs: {'kind': 'visit', 'category': 'ac', 'priority': 'urgent', 'problem': 'المكيف لا يبرد', 'address': 'مشرف، ق 3', 'previous': ['1: فحص']});
    expect((t.isService, t.urgent, t.problem, t.address), (true, true, 'المكيف لا يبرد', 'مشرف، ق 3'));
    expect(t.previousVisits, ['1: فحص']);
    expect(nextActions(t.copyWith(status: 'accepted')), [TaskAction.start]);
    expect(nextActions(t.copyWith(status: 'in_progress')), [TaskAction.arrived, TaskAction.fail]);
    expect(nextActions(t.copyWith(status: 'in_progress', stage: 'arrived')), [TaskAction.workDone, TaskAction.fail]);
    expect(nextActions(t.copyWith(status: 'in_progress', stage: 'work_done')), [TaskAction.complete]);
    expect(actionLabel(t, TaskAction.arrived), 'وصلت للموقع');
    expect(failReasonsFor(t), serviceFailReasons);
    expect(parseQty('1.5'), 1.5);
    expect(parseQty('٢'), 2);
    expect(parseQty('0'), isNull);
    expect(parseQty('1.234'), isNull);
  });

  test('move: load, unload with the receiver; a helper keeps the plain flow', () {
    final t = task('assigned', pack: 'moving@1', attrs: {'kind': 'move', 'move_ref': 'MV-1', 'home_size': 'apt_2', 'fragile': ['تلفزيون'], 'address': 'الجابرية، ق 4', 'pickup_address': 'السالمية، ق 10'});
    expect((t.isMoving, t.isMoveCrew, t.address, t.pickupLine), (true, false, 'الجابرية، ق 4', 'السالمية، ق 10'));
    expect(t.fragileItems, ['تلفزيون']);
    expect(nextActions(t.copyWith(status: 'accepted')), [TaskAction.start]);
    expect(nextActions(t.copyWith(status: 'in_progress')), [TaskAction.loaded, TaskAction.fail]);
    expect(nextActions(t.copyWith(status: 'in_progress', stage: 'loaded')), [TaskAction.unloaded, TaskAction.fail]);
    expect(nextActions(t.copyWith(status: 'in_progress', stage: 'unloaded')), [TaskAction.complete]);
    expect(actionLabel(t, TaskAction.loaded), 'انتهى التحميل');
    expect(failReasonsFor(t), movingFailReasons);
    final h = task('assigned', pack: 'moving@1', attrs: {'kind': 'crew', 'move_ref': 'MV-1', 'address': 'الجابرية، ق 4'});
    expect((h.isMoving, h.isMoveCrew, h.address), (false, true, 'الجابرية، ق 4'));
    expect(nextActions(h.copyWith(status: 'in_progress')), [TaskAction.complete, TaskAction.fail]);
    expect(actionLabel(h, TaskAction.start), 'بدأت العمل');
  });

  test('container leg: pick with the number, drop with the receiver or gate receipt', () {
    final t = task('assigned', pack: 'containers@1', attrs: {'kind': 'leg', 'leg': 'empty_to_depot', 'container_no': 'MSCU1234566', 'gate': true, 'address': 'ساحة الصليبية', 'pickup_address': 'الري'});
    expect((t.isContainer, t.containerNo, t.needsGateRef, t.address, t.pickupLine), (true, 'MSCU1234566', true, 'ساحة الصليبية', 'الري'));
    expect(nextActions(t.copyWith(status: 'accepted')), [TaskAction.start]);
    expect(nextActions(t.copyWith(status: 'in_progress')), [TaskAction.ctrPicked, TaskAction.fail]);
    expect(nextActions(t.copyWith(status: 'in_progress', stage: 'ctr_picked')), [TaskAction.ctrDropped, TaskAction.fail]);
    expect(nextActions(t.copyWith(status: 'in_progress', stage: 'ctr_dropped')), [TaskAction.complete]);
    expect(actionLabel(t, TaskAction.ctrPicked), 'سحبت الحاوية');
    expect(failReasonsFor(t), containerFailReasons);
    expect(normContainer('csqu 305438-3'), 'CSQU3054383');
    expect(normContainer('CSQU3054384'), isNull);
    expect(normContainer('MSCU1234566'), 'MSCU1234566');
  });

  test('tanker trip: fill then discharge; litres typed', () {
    final t = task('assigned', pack: 'tankers@1', attrs: {'kind': 'tank', 'product': 'diesel', 'qty_l': 5000, 'capacity_l': 20000, 'address': 'حولي، ق 2'});
    expect((t.isTanker, t.product, t.qtyL, t.capacityL, t.address), (true, 'diesel', 5000, 20000, 'حولي، ق 2'));
    expect(nextActions(t.copyWith(status: 'in_progress')), [TaskAction.tankFilled, TaskAction.fail]);
    expect(nextActions(t.copyWith(status: 'in_progress', stage: 'tank_filled')), [TaskAction.tankDischarged, TaskAction.fail]);
    expect(nextActions(t.copyWith(status: 'in_progress', stage: 'tank_discharged')), [TaskAction.complete]);
    expect(actionLabel(t, TaskAction.tankFilled), 'تمت التعبئة');
    expect(failReasonsFor(t), tankerFailReasons);
    expect(parseLitres('10,000'), 10000);
    expect(parseLitres('٥٠٠٠'), 5000);
    expect(parseLitres('70000'), isNull);
    expect(parseLitres('1.5'), isNull);
  });

  test('school trip: students marked; the trip ends with nobody on the bus and everyone marked', () {
    final t = task('in_progress', pack: 'school@1', attrs: {'kind': 'attend', 'direction': 'from_school', 'school_name': 'مدرسة النور'});
    expect((t.isSchool, t.toSchool, t.isAttendant), (true, false, true));
    final kids = [
      {'id': 'a', 'name': 'سارة', 'stop_seq': 1, 'handover': true, 'event': 'boarded'},
      {'id': 'b', 'name': 'عبدالله', 'stop_seq': 1},
      {'id': 'c', 'name': 'نورة', 'stop_seq': 2, 'excused': true},
    ];
    var x = t.copyWith(school: {'students': kids});
    expect(x.students.map((s) => s.state).toList(), ['on_board', 'waiting', 'excused']);
    expect(x.schoolFinishBlock, 'students_on_board');
    x = t.copyWith(school: {'students': [{...kids[0], 'event': 'dropped', 'received_by': 'أم سارة'}, kids[1], kids[2]]});
    expect(x.schoolFinishBlock, 'students_unmarked');
    x = t.copyWith(school: {'students': [{...kids[0], 'event': 'dropped'}, {...kids[1], 'event': 'absent'}, kids[2]]});
    expect(x.schoolFinishBlock, isNull);
    expect(actionLabel(t, TaskAction.complete), 'وصلت وأنهيت الرحلة');
    expect(failReasonsFor(t), schoolFailReasons);
  });

  test('taxi ride: arrive, pick up, drop with km and payment; the fare from the tariff or fixed', () {
    final t = task('in_progress', pack: 'taxi@1', attrs: {'kind': 'ride', 'passenger_name': 'محمد', 'address': 'حولي، ق 3', 'class': 'sedan',
      'tariff': {'base': '0.350', 'per_km': '0.150', 'per_wait_min': '0.050', 'min_fare': '1.000'}});
    expect((t.isTaxi, t.passengerName, t.address, t.onAccount), (true, 'محمد', 'حولي، ق 3', false));
    expect(nextActions(t), [TaskAction.txArrived, TaskAction.fail]);
    expect(nextActions(t.copyWith(stage: 'tx_arrived')), [TaskAction.txPicked, TaskAction.fail]);
    expect(nextActions(t.copyWith(stage: 'tx_picked')), [TaskAction.txDropped]);
    expect(nextActions(t.copyWith(stage: 'tx_dropped')), [TaskAction.complete]);
    expect(t.fareFor(10, 0), '1.850');
    expect(t.fareFor(10, 8), '2.000');
    expect(t.fareFor(2, 0), '1.000');
    expect(task('in_progress', pack: 'taxi@1', attrs: {'fixed_fare': '12.000'}).fareFor(30, 20), '12.000');
    expect(task('in_progress', pack: 'taxi@1').fareFor(5, 0), isNull);
    expect(parseKm('12.5'), 12.5);
    expect(parseKm('١٢٫٥'), 12.5);
    expect(parseKm('12.55'), isNull);
    expect(parseKm('2000'), isNull);
    expect(actionLabel(t, TaskAction.txPicked), 'ركب الراكب');
    expect(failReasonsFor(t), taxiFailReasons);
  });

  test('courier parcel line', () {
    expect(task('assigned', attrs: {'awb': 'KW1234567890', 'pieces': 2, 'attempt': 1, 'max_attempts': 3}).parcelLine, '2 قطع');
    expect(task('assigned', attrs: {'awb': 'TST-1', 'pieces': 1, 'attempt': 2, 'max_attempts': 3}).parcelLine, '1 قطعة · المحاولة 2 من 3');
    expect(task('assigned').parcelLine, isNull);
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

  test('tour bus: board with heads and odometer, return, then done; the itinerary', () {
    final t = task('in_progress', pack: 'tour@1', attrs: {'kind': 'tour', 'group_name': 'عمرة رجب', 'address': 'الجهراء', 'seats': 50,
        'itinerary': [{'place': 'منفذ السالمي', 'at': '2026-12-01T06:00:00Z'}, {'place': 'مكة'}]});
    expect((t.isTour, t.address, t.itinerary.length), (true, 'الجهراء', 2));
    expect(nextActions(t), [TaskAction.trBoarded, TaskAction.fail]);
    expect(nextActions(t.copyWith(stage: 'tr_boarded')), [TaskAction.trReturned, TaskAction.fail]);
    expect(nextActions(t.copyWith(stage: 'tr_returned')), [TaskAction.complete]);
    expect(nextActions(task('accepted', pack: 'tour@1')), [TaskAction.start]);
    expect(failReasonsFor(t), tourFailReasons);
    expect((parseCount('٤٨', 50), parseCount('51', 50), parseCount('1,200', 10000000), parseCount('x', 9)), (48, null, 1200, null));
  });

  test('oilfield journey: inspect, depart, call in, arrive', () {
    final t = task('in_progress', pack: 'oilgas@1', attrs: {'kind': 'journey', 'address': 'مركز تجميع 1، برقان', 'h2s_zone': true});
    expect((t.isOilgas, t.address), (true, 'مركز تجميع 1، برقان'));
    expect(nextActions(t), [TaskAction.ogInspect, TaskAction.fail]);
    expect(nextActions(t.copyWith(stage: 'og_inspected')), [TaskAction.ogDepart, TaskAction.fail]);
    expect(nextActions(t.copyWith(stage: 'og_departed')), [TaskAction.ogCheckin, TaskAction.ogArrived, TaskAction.fail]);
    expect(nextActions(t.copyWith(stage: 'og_checkin')), [TaskAction.ogCheckin, TaskAction.ogArrived, TaskAction.fail]);
    expect(nextActions(t.copyWith(stage: 'og_arrived')), [TaskAction.complete]);
    expect(actionLabel(t, TaskAction.ogCheckin), 'بلاغ: الوضع سليم');
    expect(failReasonsFor(t), oilgasFailReasons);
  });

  test('crane day: lift plans, critical blocked until approved, the day stays open while a lift is planned', () {
    final t = DriverTask.fromJson({'id': 't', 'status': 'in_progress', 'sector_pack': 'equipment@1', 'attributes': {}, 'version': 1, 'lifts': [
      {'id': 'a', 'ref': 'LP-1', 'time': '09:00:00', 'description': 'جسر', 'load_t': 10, 'radius_m': 8, 'rated_t': 20, 'utilization': 50, 'critical': false, 'approved': false, 'status': 'done', 'wind_limit_ms': 9},
      {'id': 'b', 'ref': 'LP-2', 'time': null, 'description': 'مولد', 'load_t': 16, 'radius_m': 10, 'rated_t': 20, 'utilization': 80, 'critical': true, 'approved': false, 'status': 'planned'},
    ]});
    final l = t.liftList;
    expect((l.length, l[0].time, l[0].windLimit, l[1].windLimit, l[0].blocked, l[1].blocked), (2, '09:00', 9.0, 9.8, false, true));
    expect(t.liftsOpen, true);
    expect(t.copyWith(lifts: [{...t.lifts![1] as Map, 'status': 'aborted'}]).liftsOpen, false);
    expect(task('in_progress', pack: 'equipment@1').liftList, isEmpty);
  });
}
