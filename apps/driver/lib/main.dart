import 'package:flutter/semantics.dart' show SemanticsBinding;
import 'package:flutter_localizations/flutter_localizations.dart' show GlobalWidgetsLocalizations;
import 'package:material_ui/material_ui.dart';
import 'core/app_state.dart';
import 'ui/home.dart';
import 'ui/login.dart';
import 'ui/theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  // browser tests drive the web build through the accessibility tree
  if (const bool.fromEnvironment('E2E')) SemanticsBinding.instance.ensureSemantics();
  final state = AppState()..boot();
  runApp(DriverApp(state: state));
}

/// Arabic, right-to-left, light and dark themes. The state object drives which screen shows.
class DriverApp extends StatelessWidget {
  const DriverApp({super.key, required this.state});
  final AppState state;

  @override
  Widget build(BuildContext context) {
    return AppScope(
      state: state,
      child: MaterialApp(
        title: 'تطبيق السائق',
        debugShowCheckedModeBanner: false,
        locale: const Locale('ar'),
        supportedLocales: const [Locale('ar'), Locale('en')],
        localizationsDelegates: const [GlobalMaterialLocalizations.delegate, GlobalWidgetsLocalizations.delegate],
        theme: appTheme(Brightness.light),
        darkTheme: appTheme(Brightness.dark),
        home: ListenableBuilder(
          listenable: state,
          builder: (context, _) {
            if (!state.ready) return const Scaffold(body: Center(child: CircularProgressIndicator()));
            return state.signedIn ? const HomeScreen() : const LoginScreen();
          },
        ),
      ),
    );
  }
}
