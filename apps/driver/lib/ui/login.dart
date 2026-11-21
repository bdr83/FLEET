import 'package:material_ui/material_ui.dart';
import '../core/api.dart';
import '../core/config.dart';
import 'theme.dart';

/// Phone → SMS code → (company, if the number works for several).
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _phone = TextEditingController(), _code = TextEditingController();
  int _step = 0; // 0 phone, 1 code, 2 company
  bool _busy = false;
  String? _error, _devCode;
  List<Map<String, dynamic>> _companies = [];

  Future<void> _run(Future<void> Function() f) async {
    setState(() { _busy = true; _error = null; });
    try {
      await f();
    } on ApiException catch (e) {
      // on the code step a 400/401 means a wrong or expired code, not an expired session
      final bad = e.status == 400 || e.status == 401;
      setState(() => _error = bad && _step == 1 ? 'رمز التحقق غير صحيح أو انتهت صلاحيته' : bad && _step == 0 ? 'رقم الجوال غير صحيح' : e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final t = Theme.of(context).textTheme;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                const Icon(Icons.local_shipping_outlined, size: 56, color: brand),
                const SizedBox(height: 12),
                Text('تطبيق السائق', style: t.headlineSmall, textAlign: TextAlign.center),
                const SizedBox(height: 32),
                if (_error != null) ...[
                  Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
                  const SizedBox(height: 12),
                ],
                if (_step == 0) ...[
                  TextField(
                    key: const Key('phone'),
                    controller: _phone,
                    keyboardType: TextInputType.phone,
                    textDirection: TextDirection.ltr,
                    autofillHints: const [AutofillHints.telephoneNumber],
                    decoration: const InputDecoration(labelText: 'رقم الجوال', hintText: '5xxxxxxx', helperText: 'رقم كويتي من 8 أرقام، أو بالمفتاح الدولي لرقم آخر'),
                  ),
                  const SizedBox(height: 16),
                  FilledButton(
                    onPressed: _busy ? null : () => _run(() async {
                      final r = await s.requestCode(_normalize(_phone.text));
                      setState(() { _devCode = showDevCode ? r.devCode : null; _step = 1; });
                    }),
                    child: const Text('إرسال رمز التحقق'),
                  ),
                ],
                if (_step == 1) ...[
                  Text('أرسلنا رمزًا إلى ${_normalize(_phone.text)}', textDirection: TextDirection.rtl),
                  if (_devCode != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text('رمز التطوير: $_devCode', key: const Key('dev-code'))),
                  const SizedBox(height: 12),
                  TextField(
                    key: const Key('code'),
                    controller: _code,
                    keyboardType: TextInputType.number,
                    textDirection: TextDirection.ltr,
                    maxLength: 6,
                    autofillHints: const [AutofillHints.oneTimeCode],
                    decoration: const InputDecoration(labelText: 'رمز التحقق'),
                  ),
                  FilledButton(
                    onPressed: _busy ? null : () => _run(() async {
                      final ms = await s.verifyCode(_normalize(_phone.text), _code.text.trim());
                      if (!s.signedIn) {
                        if (ms.isEmpty) throw ApiException(403, 'هذا الرقم غير مرتبط بأي شركة. اطلب من المكتب إضافتك كسائق');
                        setState(() { _companies = ms; _step = 2; });
                      }
                    }),
                    child: const Text('دخول'),
                  ),
                  TextButton(onPressed: () => setState(() { _step = 0; _code.clear(); }), child: const Text('تغيير الرقم')),
                ],
                if (_step == 0) ...[
                  const SizedBox(height: 24),
                  TextButton.icon(
                    onPressed: () => _server(context),
                    icon: const Icon(Icons.dns_outlined, size: 18),
                    label: Text('الخادم: ${Uri.parse(s.api.baseUrl).host}', textDirection: TextDirection.ltr),
                  ),
                ],
                if (_step == 2) ...[
                  Text('اختر الشركة', style: t.titleMedium),
                  const SizedBox(height: 8),
                  for (final m in _companies)
                    Card(child: ListTile(
                      title: Text(m['tenant_name'] ?? ''),
                      trailing: const Icon(Icons.chevron_left),
                      onTap: _busy ? null : () => _run(() => s.chooseCompany(m['tenant_id'])),
                    )),
                ],
              ]),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _server(BuildContext context) async {
    final s = AppScope.of(context);
    final c = TextEditingController(text: s.api.baseUrl);
    final url = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('عنوان الخادم'),
        content: TextField(controller: c, keyboardType: TextInputType.url, textDirection: TextDirection.ltr, decoration: const InputDecoration(hintText: 'https://api.example.com')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('إلغاء')),
          FilledButton(onPressed: () => Navigator.pop(ctx, c.text), child: const Text('حفظ')),
        ],
      ),
    );
    if (url == null) return;
    try {
      await s.setServer(url);
      setState(() {});
    } on FormatException catch (e) {
      setState(() => _error = e.message);
    }
  }

  /// Kuwaiti numbers may be typed without the country code.
  String _normalize(String v) {
    final d = v.replaceAll(RegExp(r'[^\d+]'), '');
    if (d.startsWith('+')) return d;
    if (d.startsWith('00')) return '+${d.substring(2)}';
    if (d.length == 8) return '+965$d';
    return d;
  }
}
