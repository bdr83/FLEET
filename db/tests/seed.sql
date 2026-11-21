-- بيانات اختبار: شركتان A وB. تُحمّل بصلاحية superuser (تتجاوز RLS).
-- seed as superuser
INSERT INTO org.tenant VALUES ('aaaaaaaa-0000-0000-0000-000000000001','A','active'),('bbbbbbbb-0000-0000-0000-000000000002','B','active');
INSERT INTO org.legal_entity(id,tenant_id,name) VALUES
 ('aaaaaaaa-0000-0000-0000-0000000000e1','aaaaaaaa-0000-0000-0000-000000000001','A-co1'),
 ('aaaaaaaa-0000-0000-0000-0000000000e2','aaaaaaaa-0000-0000-0000-000000000001','A-co2'),
 ('bbbbbbbb-0000-0000-0000-0000000000e1','bbbbbbbb-0000-0000-0000-000000000002','B-co1');
INSERT INTO ops.task(id,tenant_id,legal_entity_id,sector_pack,status) VALUES
 ('aaaaaaaa-0000-0000-0000-0000000000a1','aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000e1','delivery@1','ready'),
 ('aaaaaaaa-0000-0000-0000-0000000000a2','aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000e2','delivery@1','ready'),
 ('bbbbbbbb-0000-0000-0000-0000000000b1','bbbbbbbb-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-0000000000e1','concrete@1','ready');
INSERT INTO fleet.asset(id,tenant_id,legal_entity_id,asset_type,plate_no,status) VALUES
 ('bbbbbbbb-0000-0000-0000-0000000000f1','bbbbbbbb-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-0000000000e1','mixer','B-123','available');
INSERT INTO workforce.worker(id,tenant_id,legal_entity_id,kind) VALUES
 ('aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000e1','driver');
SELECT geo.maintain_location_partitions();
INSERT INTO workforce.worker(id,tenant_id,legal_entity_id,kind) VALUES ('bbbbbbbb-0000-0000-0000-0000000000d2','bbbbbbbb-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-0000000000e1','driver'),('bbbbbbbb-0000-0000-0000-0000000000d3','bbbbbbbb-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-0000000000e1','driver');
