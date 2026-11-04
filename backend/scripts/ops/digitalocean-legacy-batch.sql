-- Global metadata census only. Never expand or emit an idempotency result.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL statement_timeout='20s'; SET LOCAL lock_timeout='5s';
DO $legacy_batch$
BEGIN
 IF current_database()<>'tenderdesk_app' THEN RAISE EXCEPTION 'LEGACY_BATCH_DATABASE_IDENTITY_MISMATCH';END IF;
 IF to_regclass('app_private.idempotency_records') IS NULL THEN RAISE EXCEPTION 'LEGACY_BATCH_TABLE_MISSING';END IF;
END $legacy_batch$;
WITH measured AS (
 SELECT CASE WHEN expires_at>now() THEN 'active' ELSE 'expired' END expiry,
  CASE pg_column_compression(result) WHEN 'pglz' THEN 'pglz' WHEN 'lz4' THEN 'lz4'
   ELSE CASE WHEN pg_column_compression(result) IS NULL THEN 'none' ELSE 'other' END END compression,
  result IS NULL result_is_null,pg_column_size(result)::bigint stored_bytes
 FROM app_private.idempotency_records WHERE method='BATCH' AND route='commands'
), grouped AS MATERIALIZED (
 SELECT expiry,compression,count(*) row_count,count(*) FILTER(WHERE result_is_null) null_result_count,
  coalesce(sum(stored_bytes),0) stored_bytes_sum,max(stored_bytes) stored_bytes_max,
  count(*) FILTER(WHERE stored_bytes<=65536) stored_bytes_le_64k_count,
  count(*) FILTER(WHERE stored_bytes<=1048576) stored_bytes_le_1m_count,
  count(*) FILTER(WHERE stored_bytes>1048576) stored_bytes_gt_1m_count
 FROM measured GROUP BY expiry,compression
)
SELECT jsonb_build_object('version',1,'scope','legacy_batch_commands',
 'size_basis','pg_column_size_stored_datum_bytes_not_logical_or_wire_bytes',
 'purged_state_not_inspected',true,'logical_or_wire_size_proved',false,
 'thresholds_bytes',jsonb_build_object('small',65536,'large',1048576),
 'total_rows',(SELECT coalesce(sum(row_count),0) FROM grouped),
 'active_rows',(SELECT coalesce(sum(row_count) FILTER(WHERE expiry='active'),0) FROM grouped),
 'expired_rows',(SELECT coalesce(sum(row_count) FILTER(WHERE expiry='expired'),0) FROM grouped),
 'buckets',coalesce((SELECT jsonb_agg(to_jsonb(g) ORDER BY expiry,compression) FROM grouped g),'[]'::jsonb));
ROLLBACK;
