-- 0019: الحزم القطاعية المفعّلة لكل شركة. الشركات الحالية تبقى على كل الحزم.
ALTER TABLE org.tenant ADD COLUMN packs text[] NOT NULL DEFAULT ARRAY['delivery','concrete','staffing','internal','distribution'];
