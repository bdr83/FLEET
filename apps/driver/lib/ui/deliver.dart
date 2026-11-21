import 'package:image_picker/image_picker.dart';
import 'package:material_ui/material_ui.dart';
import '../core/models.dart';
import 'theme.dart';

/// Hand-over: confirm the cash (COD), prove the delivery (recipient PIN, or a photo the office approves), complete.
class DeliverScreen extends StatefulWidget {
  const DeliverScreen({super.key, required this.taskId});
  final String taskId;
  @override
  State<DeliverScreen> createState() => _DeliverScreenState();
}

class _DeliverScreenState extends State<DeliverScreen> {
  final _pin = TextEditingController(), _name = TextEditingController();
  bool _cash = false, _busy = false, _photoMode = false;
  String? _error;
  XFile? _photo;

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final t = s.task(widget.taskId);
    if (t == null) return Scaffold(appBar: AppBar(), body: const Center(child: Text('انتهت المهمة')));
    final cod = t.codFils;
    final noPhone = t.recipientPhone == null;
    final text = Theme.of(context).textTheme;
    final cashOk = cod == 0 || _cash;
    return Scaffold(
      appBar: AppBar(title: const Text('تسليم الطلب')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Text(t.address, style: text.titleMedium),
        if (t.recipientName != null) Text(t.recipientName!),
        const SizedBox(height: 16),
        if (cod > 0)
          Card(child: CheckboxListTile(
            key: const Key('cash'),
            value: _cash,
            onChanged: (v) => setState(() => _cash = v ?? false),
            title: Row(children: [const Text('استلمت '), Ltr('${filsToMoney(cod)} KWD', style: const TextStyle(fontWeight: FontWeight.bold)), const Text(' نقدًا')]),
            subtitle: const Text('لا تسلّم الطلب قبل استلام المبلغ'),
          )),
        const SizedBox(height: 16),
        SegmentedButton<bool>(
          segments: const [
            ButtonSegment(value: false, label: Text('رمز المستلم'), icon: Icon(Icons.pin_outlined)),
            ButtonSegment(value: true, label: Text('صورة'), icon: Icon(Icons.photo_camera_outlined)),
          ],
          selected: {_photoMode},
          onSelectionChanged: (v) => setState(() { _photoMode = v.first; _error = null; }),
        ),
        const SizedBox(height: 16),
        if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 12), child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
        if (!_photoMode) ...[
          const Text('اطلب من المستلم رمز الاستلام المكوّن من 4 أرقام (يظهر في رابط التتبع الذي وصله).'),
          const SizedBox(height: 12),
          TextField(
            key: const Key('pin'),
            controller: _pin,
            keyboardType: TextInputType.number,
            textAlign: TextAlign.center,
            textDirection: TextDirection.ltr,
            maxLength: 4,
            style: const TextStyle(fontSize: 32, letterSpacing: 16, fontWeight: FontWeight.bold),
            decoration: const InputDecoration(counterText: '', labelText: 'رمز الاستلام', hintText: '••••'),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 12),
          FilledButton(
            key: const Key('confirm-pin'),
            onPressed: _busy || !cashOk || !RegExp(r'^\d{4}$').hasMatch(_pin.text) ? null : () => _withPin(t),
            child: _busy ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('تأكيد التسليم'),
          ),
          if (noPhone) ...[
            const SizedBox(height: 8),
            TextButton(onPressed: _busy || !cashOk ? null : () => _finish(t), child: const Text('لا يوجد رمز لهذا الطلب، تسليم مباشر')),
          ],
        ] else ...[
          const Text('عند تعذّر الرمز: صوّر الطلب عند الباب أو مع المستلم. يراجع المكتب الصورة قبل اعتماد المهمة.'),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            key: const Key('take-photo'),
            onPressed: _busy ? null : _takePhoto,
            icon: const Icon(Icons.photo_camera),
            label: Text(_photo == null ? 'التقاط صورة' : 'إعادة التقاط'),
          ),
          if (_photo != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text('الصورة جاهزة: ${_photo!.name}', textDirection: TextDirection.ltr)),
          const SizedBox(height: 12),
          TextField(controller: _name, maxLength: 120, decoration: const InputDecoration(labelText: 'اسم من استلم (اختياري)')),
          FilledButton(
            key: const Key('confirm-photo'),
            onPressed: _busy || !cashOk || _photo == null ? null : () => _withPhoto(t),
            child: const Text('تأكيد التسليم بالصورة'),
          ),
        ],
      ]),
    );
  }

  Future<void> _takePhoto() async {
    // compressed on the phone so it uploads fast on a weak connection (server limit 2 MB)
    final x = await ImagePicker().pickImage(source: ImageSource.camera, maxWidth: 1280, imageQuality: 60, preferredCameraDevice: CameraDevice.rear);
    if (x != null) setState(() => _photo = x);
  }

  Future<void> _withPin(DriverTask t) async {
    setState(() { _busy = true; _error = null; });
    final s = AppScope.of(context);
    final err = await s.provePin(t.id, _pin.text);
    if (!mounted) return;
    if (err != null) {
      setState(() { _busy = false; _error = err; _pin.clear(); if (err.contains('أُقفل')) _photoMode = true; });
      return;
    }
    await _finish(t);
  }

  Future<void> _withPhoto(DriverTask t) async {
    setState(() => _busy = true);
    final bytes = await _photo!.readAsBytes();
    if (!mounted) return;
    await AppScope.of(context).provePhoto(t.id, bytes, recipientName: _name.text.trim().isEmpty ? null : _name.text.trim());
    await _finish(t);
  }

  Future<void> _finish(DriverTask t) async {
    final s = AppScope.of(context);
    if (t.codFils > 0) await s.collectCod(t.id, t.codFils);
    await s.setStatus(t.id, 'completed');
    if (!mounted) return;
    toast(context, s.offline ? 'سُجّل التسليم وسيُرسل عند عودة الاتصال' : 'تم التسليم');
    Navigator.of(context).popUntil((r) => r.isFirst);
  }
}
