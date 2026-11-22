import 'package:material_ui/material_ui.dart';
import '../core/models.dart';
import 'theme.dart';

/// A distribution stop: what was delivered of each planned item (prefilled with the plan), what the branch gave back,
/// the cash for a cash customer (the amount due is computed from what was delivered) and who received the goods.
class StopScreen extends StatefulWidget {
  const StopScreen({super.key, required this.taskId});
  final String taskId;
  @override
  State<StopScreen> createState() => _StopScreenState();
}

class _StopScreenState extends State<StopScreen> {
  final _delivered = <String, TextEditingController>{};
  final _returned = <String, TextEditingController>{};
  final _damaged = <String, TextEditingController>{};
  final _cash = TextEditingController();
  final _receiver = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    for (final c in [..._delivered.values, ..._returned.values, ..._damaged.values, _cash, _receiver]) {
      c.dispose();
    }
    super.dispose();
  }

  Map<String, double>? _read(Map<String, TextEditingController> m) {
    final out = <String, double>{};
    for (final e in m.entries) {
      final t = e.value.text.trim();
      if (t.isEmpty) continue;
      final n = parseM3(t);
      if (n == null || n < 0) return null;
      if (n > 0) out[e.key] = n;
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final t = s.task(widget.taskId);
    if (t == null) return Scaffold(appBar: AppBar(), body: const Center(child: Text('التوقف مسجّل')));
    final items = t.distItems;
    for (final i in items) {
      _delivered.putIfAbsent(i.sku, () => TextEditingController(text: qtyText(i.qty)));
      _returned.putIfAbsent(i.sku, () => TextEditingController());
      _damaged.putIfAbsent(i.sku, () => TextEditingController());
    }
    final delivered = _read(_delivered);
    final due = delivered == null ? null : distValueFils(items, delivered);
    final text = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: Text('تسليم ${t.attributes['name'] ?? ''}')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Text('الكمية المسلَّمة لكل صنف (عدّلها إن استلم الفرع أقل)', style: text.labelMedium),
        for (final i in items)
          Padding(padding: const EdgeInsets.only(top: 8), child: Row(children: [
            Expanded(child: Text('${i.name} (المخطط ${qtyText(i.qty)})${i.expiry != null ? '\nصلاحية ${i.expiry}' : ''}')),
            SizedBox(width: 90, child: TextField(key: Key('delivered-${i.sku}'), controller: _delivered[i.sku], textDirection: TextDirection.ltr,
                keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: InputDecoration(labelText: 'سُلّم ${i.name}', isDense: true), onChanged: (_) => setState(() {}))),
            const SizedBox(width: 8),
            SizedBox(width: 90, child: TextField(key: Key('returned-${i.sku}'), controller: _returned[i.sku], textDirection: TextDirection.ltr,
                keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: InputDecoration(labelText: 'مرتجع ${i.name}', isDense: true))),
            if (t.isCold) ...[
              const SizedBox(width: 8),
              SizedBox(width: 90, child: TextField(key: Key('damaged-${i.sku}'), controller: _damaged[i.sku], textDirection: TextDirection.ltr,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: InputDecoration(labelText: 'تالف ${i.name}', isDense: true))),
            ],
          ])),
        const SizedBox(height: 16),
        if (t.payCash) ...[
          Card(child: ListTile(leading: const Icon(Icons.payments_outlined), title: const Text('المبلغ المستحق'),
              trailing: Ltr(due == null ? '—' : '${filsToMoney(due)} KWD', style: text.titleLarge))),
          TextField(key: const Key('cash'), controller: _cash, textDirection: TextDirection.ltr, keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(labelText: 'المبلغ المحصّل (د.ك)')),
          const SizedBox(height: 12),
        ],
        TextField(controller: _receiver, maxLength: 120, decoration: const InputDecoration(labelText: 'اسم المستلم (اختياري)')),
        const SizedBox(height: 12),
        FilledButton.icon(
          key: const Key('stop-save'),
          icon: const Icon(Icons.check_circle_outline),
          label: const Text('تأكيد التسليم'),
          onPressed: _busy ? null : () => _save(context, t),
        ),
      ]),
    );
  }

  Future<void> _save(BuildContext context, DriverTask t) async {
    final delivered = _read(_delivered), returned = _read(_returned), damaged = _read(_damaged);
    if (delivered == null || returned == null || damaged == null) return toast(context, 'كمية غير صحيحة', error: true);
    if (delivered.isEmpty) return toast(context, 'لم يُسلَّم شيء: استخدم «تعذّر التسليم» بدلًا من ذلك', error: true);
    String? cash;
    if (t.payCash) {
      final f = moneyToFils(_cash.text.trim());
      if (_cash.text.trim().isEmpty) return toast(context, 'أدخل المبلغ المحصّل', error: true);
      cash = filsToMoney(f);
    }
    setState(() => _busy = true);
    final s = AppScope.of(context);
    final err = await s.stopProof(t.id, delivered: delivered, returned: returned, damaged: damaged, cash: cash, receivedBy: _receiver.text.trim().isEmpty ? null : _receiver.text.trim());
    if (!context.mounted) return;
    setState(() => _busy = false);
    if (err != null) return toast(context, err, error: true);
    toast(context, s.offline ? 'سُجّل التسليم وسيُرسل عند عودة الاتصال' : 'سُجّل التسليم');
    Navigator.of(context).pop();
  }
}
