import 'package:image_picker/image_picker.dart';
import 'package:material_ui/material_ui.dart';
import '../core/models.dart';
import 'theme.dart';

/// The digital delivery ticket: the site engineer confirms the poured and returned m³ and signs with their name,
/// with an optional photo of the signature or paper ticket. Then the load is completed.
class TicketScreen extends StatefulWidget {
  const TicketScreen({super.key, required this.taskId});
  final String taskId;
  @override
  State<TicketScreen> createState() => _TicketScreenState();
}

class _TicketScreenState extends State<TicketScreen> {
  late final TextEditingController _poured, _returned, _name;
  bool _busy = false, _init = false;
  String? _error;
  XFile? _photo;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_init) return;
    final t = AppScope.of(context).task(widget.taskId);
    _poured = TextEditingController(text: t == null ? '' : _fmt(t.volumeM3));
    _returned = TextEditingController(text: '0');
    _name = TextEditingController(text: t?.siteContact ?? '');
    _init = true;
  }

  String _fmt(double v) => v == v.roundToDouble() ? v.toStringAsFixed(0) : v.toStringAsFixed(2);

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final t = s.task(widget.taskId);
    if (t == null) return Scaffold(appBar: AppBar(), body: const Center(child: Text('انتهت الحمولة')));
    final text = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('تذكرة التسليم')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Row(children: [const Text('التذكرة '), Ltr(t.ticketNo ?? '—', style: text.titleMedium), const Spacer(), Ltr('${_fmt(t.volumeM3)} م³', style: text.titleMedium)]),
        Text(t.address, style: text.bodyMedium),
        const SizedBox(height: 16),
        if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 12), child: Text(_error!, key: const Key('ticket-error'), style: TextStyle(color: Theme.of(context).colorScheme.error))),
        TextField(key: const Key('poured'), controller: _poured, keyboardType: const TextInputType.numberWithOptions(decimal: true), textDirection: TextDirection.ltr,
            decoration: const InputDecoration(labelText: 'الكمية المصبوبة (م³)')),
        const SizedBox(height: 12),
        TextField(key: const Key('returned'), controller: _returned, keyboardType: const TextInputType.numberWithOptions(decimal: true), textDirection: TextDirection.ltr,
            decoration: const InputDecoration(labelText: 'الكمية المرتجعة (م³)', helperText: 'ما بقي في الخلاطة ويعود للمحطة')),
        const SizedBox(height: 12),
        TextField(key: const Key('signed-by'), controller: _name, maxLength: 120, decoration: const InputDecoration(labelText: 'اسم مهندس الموقع الموقّع')),
        OutlinedButton.icon(
          key: const Key('ticket-photo'),
          onPressed: _busy ? null : _takePhoto,
          icon: const Icon(Icons.photo_camera_outlined),
          label: Text(_photo == null ? 'صورة التوقيع أو التذكرة الورقية (اختياري)' : 'إعادة التقاط الصورة'),
        ),
        if (_photo != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text('الصورة جاهزة: ${_photo!.name}', textDirection: TextDirection.ltr)),
        const SizedBox(height: 16),
        const Text('بالتوقيع يؤكد مهندس الموقع استلام الكمية المصبوبة. لا تُعدّل التذكرة بعد إرسالها.'),
        const SizedBox(height: 12),
        FilledButton(
          key: const Key('confirm-ticket'),
          onPressed: _busy ? null : () => _submit(t),
          child: _busy ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('تأكيد التذكرة وإنهاء الحمولة'),
        ),
      ]),
    );
  }

  Future<void> _takePhoto() async {
    final x = await ImagePicker().pickImage(source: ImageSource.camera, maxWidth: 1280, imageQuality: 60, preferredCameraDevice: CameraDevice.rear);
    if (x != null) setState(() => _photo = x);
  }

  Future<void> _submit(DriverTask t) async {
    final poured = parseM3(_poured.text), returned = parseM3(_returned.text.isEmpty ? '0' : _returned.text);
    final bad = ticketError(t.volumeM3, poured, returned, _name.text);
    if (bad != null) return setState(() => _error = bad);
    setState(() { _busy = true; _error = null; });
    final s = AppScope.of(context);
    final bytes = await _photo?.readAsBytes();
    final err = await s.signTicket(t.id, poured: poured!, returned: returned!, signedBy: _name.text.trim(), jpeg: bytes);
    if (!mounted) return;
    if (err != null) return setState(() { _busy = false; _error = err; });
    await s.setStatus(t.id, 'completed');
    if (!mounted) return;
    toast(context, s.offline ? 'سُجّلت التذكرة وستُرسل عند عودة الاتصال' : 'تم تسليم الحمولة');
    Navigator.of(context).popUntil((r) => r.isFirst);
  }
}
