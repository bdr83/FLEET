import 'package:material_ui/material_ui.dart';
import '../core/app_state.dart';

const brand = Color(0xFF0E7490);

ThemeData appTheme(Brightness b) {
  final scheme = ColorScheme.fromSeed(seedColor: brand, brightness: b);
  return ThemeData(
    colorScheme: scheme,
    useMaterial3: true,
    fontFamilyFallback: const ['Noto Sans Arabic', 'Tahoma', 'Arial'],
    inputDecorationTheme: const InputDecorationTheme(border: OutlineInputBorder()),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52), textStyle: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48))),
    cardTheme: const CardThemeData(margin: EdgeInsets.zero),
  );
}

/// Gives every screen access to the app state.
class AppScope extends InheritedNotifier<AppState> {
  const AppScope({super.key, required AppState state, required super.child}) : super(notifier: state);
  static AppState of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<AppScope>()!.notifier!;
}

/// Numbers, phones and plates read left-to-right inside Arabic text.
class Ltr extends StatelessWidget {
  const Ltr(this.text, {super.key, this.style});
  final String text;
  final TextStyle? style;
  @override
  Widget build(BuildContext context) => Directionality(textDirection: TextDirection.ltr, child: Text(text, style: style));
}

void toast(BuildContext context, String msg, {bool error = false}) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(msg), backgroundColor: error ? Theme.of(context).colorScheme.error : null));
}

String two(int n) => n.toString().padLeft(2, '0');
/// Kuwait time (UTC+3, no daylight saving), dd/mm HH:mm.
String kwTime(DateTime? d, {bool date = false}) {
  if (d == null) return '—';
  final k = d.toUtc().add(const Duration(hours: 3));
  final t = '${two(k.hour)}:${two(k.minute)}';
  return date ? '${two(k.day)}/${two(k.month)} $t' : t;
}
