import 'package:material_ui/material_ui.dart';
import '../core/api.dart';
import '../core/models.dart';
import 'task.dart';
import 'theme.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final active = s.tasks.where((t) => t.status != 'failed').toList();
    final returns = s.tasks.where((t) => t.status == 'failed').toList();
    return Scaffold(
      appBar: AppBar(
        title: Text(s.worker?.displayName ?? 'مهامي'),
        actions: [
          _SyncIcon(pending: s.queue.pending, offline: s.offline, onTap: s.sync),
          PopupMenuButton<String>(
            onSelected: (v) async {
              if (v == 'out') await s.signOut();
            },
            itemBuilder: (_) => const [PopupMenuItem(value: 'out', child: Text('تسجيل الخروج'))],
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: s.refresh,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (s.offline) _Banner(icon: Icons.cloud_off, text: 'لا يوجد اتصال. تُحفظ أعمالك على الجهاز وتُرسل تلقائيًا (${s.queue.pending})'),
            if (s.error != null) _Banner(icon: Icons.error_outline, text: s.error!, error: true),
            if (s.queue.problems.isNotEmpty) _ProblemsCard(problems: s.queue.problems, onDismiss: s.dismissProblems),
            const _ShiftCard(),
            const SizedBox(height: 20),
            Row(children: [
              Text('مهامي', style: Theme.of(context).textTheme.titleLarge),
              const Spacer(),
              if (s.loading) const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
            ]),
            const SizedBox(height: 8),
            if (active.isEmpty)
              const Padding(padding: EdgeInsets.symmetric(vertical: 40), child: Center(child: Text('لا توجد مهام مسندة إليك الآن'))),
            for (final t in active) _TaskTile(task: t),
            if (returns.isNotEmpty) ...[
              const SizedBox(height: 20),
              Text('للإرجاع إلى المرسل', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              for (final t in returns) _TaskTile(task: t),
            ],
          ],
        ),
      ),
    );
  }
}

class _SyncIcon extends StatelessWidget {
  const _SyncIcon({required this.pending, required this.offline, required this.onTap});
  final int pending;
  final bool offline;
  final Future<void> Function() onTap;
  @override
  Widget build(BuildContext context) => IconButton(
        tooltip: pending == 0 ? 'كل شيء مُرسل' : '$pending بانتظار الإرسال',
        onPressed: onTap,
        icon: Badge(
          isLabelVisible: pending > 0,
          label: Text('$pending'),
          child: Icon(offline ? Icons.cloud_off : (pending > 0 ? Icons.cloud_upload_outlined : Icons.cloud_done_outlined)),
        ),
      );
}

class _Banner extends StatelessWidget {
  const _Banner({required this.icon, required this.text, this.error = false});
  final IconData icon;
  final String text;
  final bool error;
  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: error ? c.errorContainer : c.secondaryContainer, borderRadius: BorderRadius.circular(10)),
      child: Row(children: [Icon(icon, size: 20), const SizedBox(width: 8), Expanded(child: Text(text))]),
    );
  }
}

class _ProblemsCard extends StatelessWidget {
  const _ProblemsCard({required this.problems, required this.onDismiss});
  final List problems;
  final VoidCallback onDismiss;
  @override
  Widget build(BuildContext context) => Card(
        color: Theme.of(context).colorScheme.errorContainer,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('رفض الخادم بعض الإجراءات', style: TextStyle(fontWeight: FontWeight.bold)),
            for (final p in problems) Text('• ${rejectReasons[p.reason] ?? p.reason}'),
            Align(alignment: AlignmentDirectional.centerEnd, child: TextButton(onPressed: onDismiss, child: const Text('فهمت'))),
          ]),
        ),
      );
}

class _ShiftCard extends StatelessWidget {
  const _ShiftCard();
  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final shift = s.shift;
    final c = Theme.of(context).colorScheme;
    return Card(
      color: shift == null ? null : c.primaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            Icon(shift == null ? Icons.pause_circle_outline : Icons.play_circle_fill, color: shift == null ? null : brand),
            const SizedBox(width: 8),
            Text(shift == null ? 'الوردية مغلقة' : 'الوردية مفتوحة منذ ${kwTime(shift.startedAt)}', style: Theme.of(context).textTheme.titleMedium),
          ]),
          if (shift?.plateNo != null) Padding(padding: const EdgeInsets.only(top: 6), child: Row(children: [const Text('المركبة: '), Ltr(shift!.plateNo!)])),
          const SizedBox(height: 4),
          Text(shift == null ? 'ابدأ الوردية لاستلام المهام ومشاركة موقعك مع المكتب.' : 'يُشارك موقعك مع المكتب حتى تنهي الوردية.', style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 12),
          shift == null
              ? FilledButton.icon(key: const Key('start-shift'), onPressed: () => _startShift(context), icon: const Icon(Icons.play_arrow), label: const Text('بدء الوردية'))
              : OutlinedButton.icon(onPressed: () => _endShift(context), icon: const Icon(Icons.stop), label: const Text('إنهاء الوردية')),
        ]),
      ),
    );
  }

  Future<void> _startShift(BuildContext context) async {
    final s = AppScope.of(context);
    List<Vehicle> vehicles = [];
    try {
      vehicles = await s.vehicles();
    } on ApiException catch (e) {
      if (context.mounted) toast(context, e.message, error: true);
      return;
    }
    if (!context.mounted) return;
    String? asset = vehicles.length == 1 ? vehicles.first.id : null;
    final odo = TextEditingController();
    final go = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, set) => Padding(
          padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('بدء الوردية', style: Theme.of(ctx).textTheme.titleLarge),
            const SizedBox(height: 16),
            DropdownButtonFormField<String?>(
              initialValue: asset,
              decoration: const InputDecoration(labelText: 'المركبة'),
              items: [
                const DropdownMenuItem(value: null, child: Text('بدون مركبة (مشيًا أو مركبة خاصة)')),
                for (final v in vehicles) DropdownMenuItem(value: v.id, child: Text(v.plateNo ?? v.type, textDirection: TextDirection.ltr)),
              ],
              onChanged: (v) => set(() => asset = v),
            ),
            if (asset != null) ...[
              const SizedBox(height: 12),
              TextField(controller: odo, keyboardType: TextInputType.number, textDirection: TextDirection.ltr, decoration: const InputDecoration(labelText: 'قراءة العدّاد (كم) - اختياري')),
            ],
            const SizedBox(height: 16),
            FilledButton(key: const Key('confirm-start'), onPressed: () => Navigator.pop(ctx, true), child: const Text('ابدأ')),
          ]),
        ),
      ),
    );
    if (go != true || !context.mounted) return;
    try {
      await s.startShift(assetId: asset, odometerKm: int.tryParse(odo.text.trim()));
      if (context.mounted && s.error != null) toast(context, s.error!, error: true);
    } on ApiException catch (e) {
      if (context.mounted) toast(context, e.message, error: true);
    }
  }

  Future<void> _endShift(BuildContext context) async {
    final s = AppScope.of(context);
    final odo = TextEditingController();
    final go = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('إنهاء الوردية؟'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          if (s.tasks.any((t) => t.status == 'in_progress')) const Text('لديك مهمة قيد التنفيذ.'),
          if (s.shift?.assetId != null)
            TextField(controller: odo, keyboardType: TextInputType.number, textDirection: TextDirection.ltr, decoration: const InputDecoration(labelText: 'قراءة العدّاد (كم)')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('رجوع')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('إنهاء')),
        ],
      ),
    );
    if (go != true) return;
    try {
      await s.endShift(odometerKm: int.tryParse(odo.text.trim()));
    } on ApiException catch (e) {
      if (context.mounted) toast(context, e.message, error: true);
    }
  }
}

class _TaskTile extends StatelessWidget {
  const _TaskTile({required this.task});
  final DriverTask task;
  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final t = task;
    final c = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Card(
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => TaskScreen(taskId: t.id))),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Chip(label: Text(t.stage != null ? stageLabels[t.stage] ?? t.stage! : statusLabels[t.status] ?? t.status), visualDensity: VisualDensity.compact),
                const SizedBox(width: 8),
                if (t.ref != null) Ltr(t.ref!, style: Theme.of(context).textTheme.bodySmall),
                const Spacer(),
                if (t.windowTo != null) Text('حتى ${kwTime(t.windowTo)}'),
                if (s.queue.hasPendingFor(t.id)) const Padding(padding: EdgeInsetsDirectional.only(start: 6), child: Icon(Icons.schedule_send, size: 18)),
              ]),
              const SizedBox(height: 6),
              Text(t.address.isEmpty ? 'بدون عنوان' : t.address, style: Theme.of(context).textTheme.titleMedium),
              if (t.recipientName != null) Text(t.recipientName!),
              if (t.isInternal && t.purpose != null) Text('${t.purpose}${t.requester != null ? ' · ${t.requester}' : ''}'),
              if (t.isStaffing && t.shift != null) Row(children: [const Text('الدوام '), Ltr(t.shift!), if (t.workDate != null) ...[const Text(' · '), Ltr(t.workDate!)]]),
              if (t.codFils > 0) Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Row(children: [Icon(Icons.payments_outlined, size: 18, color: c.tertiary), const SizedBox(width: 4), const Text('تحصيل '), Ltr('${filsToMoney(t.codFils)} KWD', style: const TextStyle(fontWeight: FontWeight.bold))]),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}
