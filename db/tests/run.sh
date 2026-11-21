#!/usr/bin/env bash
# اختبارات العزل والقيود والمحاسبة على قاعدة حقيقية (المرحلة E).
# ADMIN_DATABASE_URL: superuser لتحميل البيانات. APP_DATABASE_URL: دور app_rw.
set -uo pipefail
cd "$(dirname "$0")"
: "${ADMIN_DATABASE_URL:?}" "${APP_DATABASE_URL:?}"
psql "$ADMIN_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f seed.sql >/dev/null || exit 1
# كل جدول فيه tenant_id يجب أن يكون محميًا بـ RLS
missing=$(psql "$ADMIN_DATABASE_URL" -X -tAc "SELECT string_agg(c.oid::regclass::text, ', ') FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='tenant_id' WHERE c.relkind IN ('r','p') AND NOT c.relispartition AND NOT c.relrowsecurity")
if [ -n "$missing" ]; then echo "FAIL tables without RLS: $missing"; exit 1; fi
echo "PASS all tenant tables have RLS"
A=aaaaaaaa-0000-0000-0000-000000000001; B=bbbbbbbb-0000-0000-0000-000000000002
pass=0; fail=0
chk(){ # id expect(ok|err) pattern sql
 out=$(psql "$APP_DATABASE_URL" -X -tAq -v ON_ERROR_STOP=1 -c "$4" 2>&1 | tr '\n' ' ')
 if [ "$2" = ok ]; then echo "$out" | grep -q ERROR && r=FAIL || { echo "$out" | grep -q -- "$3" && r=PASS || r=FAIL; }
 else echo "$out" | grep -q -- "$3" && r=PASS || r=FAIL; fi
 [ $r = PASS ] && pass=$((pass+1)) || fail=$((fail+1)); printf "%-5s %-4s %s\n" "$1" "$r" "$(echo $out | cut -c1-110)"; }
S="SET app.tenant_id='$A';"; SB="SET app.tenant_id='$B';"
chk 1.1 ok '^2' "$S SELECT count(*) FROM ops.task"
chk 1.2 err 'unrecognized configuration' "SELECT count(*) FROM ops.task"
chk 1.3 err 'row-level security' "$S INSERT INTO ops.task(id,tenant_id,legal_entity_id,sector_pack,status) VALUES (gen_random_uuid(),'$B','bbbbbbbb-0000-0000-0000-0000000000e1','x','ready')"
chk 1.4 err 'invalid input syntax' "BEGIN; SET LOCAL app.tenant_id='$A'; SELECT 1; COMMIT; SELECT count(*) FROM ops.task"
chk 1.5 ok '^0' "$S SELECT count(*) FROM fleet.asset"
chk 1.6 err 'foreign key' "$S INSERT INTO ops.assignment(id,tenant_id,task_id,worker_id,period) VALUES (gen_random_uuid(),'$A','bbbbbbbb-0000-0000-0000-0000000000b1','aaaaaaaa-0000-0000-0000-0000000000d1','[2026-12-05 08:00,2026-12-05 09:00)')"
chk 2.1 ok '^1' "$S SET app.entity_ids='{aaaaaaaa-0000-0000-0000-0000000000e1}'; SELECT count(*) FROM ops.task"
E="INSERT INTO ops.task_event(id,tenant_id,task_id,to_status,occurred_at,client_op_id) VALUES"
chk 4.1 ok '^1' "$S $E (gen_random_uuid(),'$A','aaaaaaaa-0000-0000-0000-0000000000a1','accepted',now(),'22222222-0000-0000-0000-000000000001'); $E (gen_random_uuid(),'$A','aaaaaaaa-0000-0000-0000-0000000000a1','accepted',now(),'22222222-0000-0000-0000-000000000001') ON CONFLICT DO NOTHING; SELECT count(*) FROM ops.task_event"
L="INSERT INTO geo.location_point(tenant_id,worker_id,shift_id,recorded_at,position,source) VALUES"
chk 4.3 ok 'ok' "$S $L ('$A','aaaaaaaa-0000-0000-0000-0000000000d1',gen_random_uuid(),now(),ST_GeogFromText('POINT(47.98 29.37)'),'fg') RETURNING 'ok'"
chk 4.4 ok 'ok' "$S $L ('$A','aaaaaaaa-0000-0000-0000-0000000000d1',gen_random_uuid(),'2030-01-01',ST_GeogFromText('POINT(47.98 29.37)'),'sync') RETURNING 'ok'"
G="INSERT INTO ops.assignment(id,tenant_id,task_id,worker_id,period) VALUES"
chk 7.0 ok 'ok' "$S $G (gen_random_uuid(),'$A','aaaaaaaa-0000-0000-0000-0000000000a1','aaaaaaaa-0000-0000-0000-0000000000d1','[2026-12-01 08:00,2026-12-01 09:00)') RETURNING 'ok'"
chk 7.1 err 'no_worker_overlap' "$S $G (gen_random_uuid(),'$A','aaaaaaaa-0000-0000-0000-0000000000a1','aaaaaaaa-0000-0000-0000-0000000000d1','[2026-12-01 08:30,2026-12-01 09:30)')"
chk 7.2 ok 'ok' "$S $G (gen_random_uuid(),'$A','aaaaaaaa-0000-0000-0000-0000000000a1','aaaaaaaa-0000-0000-0000-0000000000d1','[2026-12-01 09:00,2026-12-01 10:00)') RETURNING 'ok'"
chk 7.3 ok 'ok' "$S INSERT INTO ops.assignment(id,tenant_id,task_id,worker_id,period,exclusive) VALUES (gen_random_uuid(),'$A','aaaaaaaa-0000-0000-0000-0000000000a2','aaaaaaaa-0000-0000-0000-0000000000d1','[2026-12-01 08:15,2026-12-01 08:45)',false) RETURNING 'ok'"
chk 7.4 err 'no_asset_overlap' "$SB INSERT INTO ops.assignment(id,tenant_id,task_id,worker_id,asset_id,period,exclusive) VALUES (gen_random_uuid(),'$B','bbbbbbbb-0000-0000-0000-0000000000b1','bbbbbbbb-0000-0000-0000-0000000000d2','bbbbbbbb-0000-0000-0000-0000000000f1','[2026-12-02 08:00,2026-12-02 10:00)',false); INSERT INTO ops.assignment(id,tenant_id,task_id,worker_id,asset_id,period,exclusive) VALUES (gen_random_uuid(),'$B','bbbbbbbb-0000-0000-0000-0000000000b1','bbbbbbbb-0000-0000-0000-0000000000d3','bbbbbbbb-0000-0000-0000-0000000000f1','[2026-12-02 09:00,2026-12-02 11:00)',false)"
chk 7.6 err 'one_open_shift' "$S INSERT INTO shift.shift(id,tenant_id,worker_id,period,started_at) VALUES (gen_random_uuid(),'$A','aaaaaaaa-0000-0000-0000-0000000000d1','[2026-12-01,2026-12-02)',now()); INSERT INTO shift.shift(id,tenant_id,worker_id,period,started_at) VALUES (gen_random_uuid(),'$A','aaaaaaaa-0000-0000-0000-0000000000d1','[2026-12-01,2026-12-02)',now())"
J="INSERT INTO billing.ledger_entry(id,tenant_id,legal_entity_id,journal_id,account_code,amount,currency,source_type,source_id) VALUES"
chk 8.1 err 'not balanced' "$S BEGIN; $J (gen_random_uuid(),'$A',gen_random_uuid(),gen_random_uuid(),'1100',10,'KWD','i',gen_random_uuid()); COMMIT"
chk 8.2 ok 'committed' "$S BEGIN; $J (gen_random_uuid(),'$A',gen_random_uuid(),'11111111-0000-0000-0000-000000000002','1100',10,'KWD','i',gen_random_uuid()),(gen_random_uuid(),'$A',gen_random_uuid(),'11111111-0000-0000-0000-000000000002','4000',-10,'KWD','i',gen_random_uuid()); COMMIT; SELECT 'committed'"
chk 8.3 err 'not balanced' "$S BEGIN; $J (gen_random_uuid(),'$A',gen_random_uuid(),'11111111-0000-0000-0000-000000000003','1100',10,'KWD','i',gen_random_uuid()),(gen_random_uuid(),'$A',gen_random_uuid(),'11111111-0000-0000-0000-000000000003','4000',-10,'USD','i',gen_random_uuid()); COMMIT"
chk 15.1 err 'permission denied' "$S UPDATE billing.ledger_entry SET amount=0"
chk 15.2 err 'permission denied' "$S DELETE FROM core.audit_log"
chk 15.3 err 'permission denied' "TRUNCATE billing.ledger_entry"
echo "PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ]
