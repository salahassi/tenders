import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
let raw='';for await(const chunk of process.stdin)raw+=chunk;
const {sql}=JSON.parse(raw);const db=new PGlite();await db.waitReady;
const query=sql.replace("current_database()<>'tenderdesk_app'","current_database()<>'postgres'");
async function census(){const result=await db.exec(query);return result.find(row=>row.rows.length)?.rows[0].jsonb_build_object;}
try {
 await db.exec(`CREATE ROLE tdp_app_owner;CREATE SCHEMA app_private AUTHORIZATION tdp_app_owner;
  CREATE TABLE app_private.idempotency_records(workspace_id uuid,actor_id uuid,method text,route text,key text,body_hash text,result jsonb,expires_at timestamptz NOT NULL);
  ALTER TABLE app_private.idempotency_records OWNER TO tdp_app_owner;
  ALTER TABLE app_private.idempotency_records ENABLE ROW LEVEL SECURITY;
  ALTER TABLE app_private.idempotency_records ALTER COLUMN result SET COMPRESSION pglz;`);
 assert.deepEqual((await census()).buckets,[]);
 const write=async(key,value,active,method='BATCH',route='commands')=>db.query(`INSERT INTO app_private.idempotency_records VALUES('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',$1,$2,$3,'synthetic-hash',$4::jsonb,now()+$5::interval)`,[method,route,key,value,active?'1 hour':'-1 hour']);
 // Large compressible fixture: physical storage is deliberately far smaller
 // than its known input. The census never serializes or measures that JSON.
 await write('compressed',JSON.stringify({synthetic:'X'.repeat(2*1024*1024)}),true);
 await write('sql-null',null,true);
 await write('json-null','null',true);
 await write('sentinel',JSON.stringify({purged:true}),false);
 await db.exec('ALTER TABLE app_private.idempotency_records ALTER COLUMN result SET STORAGE EXTERNAL');
 await write('medium',JSON.stringify({synthetic:'Y'.repeat(128*1024)}),false);
 await write('large',JSON.stringify({synthetic:'Z'.repeat(2*1024*1024)}),true);
 await write('small',JSON.stringify({synthetic:'PRIVATE_FIXTURE_CONTENT'}),true);
 await write('excluded-command',JSON.stringify({synthetic:'PRIVATE_OTHER_OPERATION'}),true,'COMMAND');
 await write('excluded-route',JSON.stringify({synthetic:'PRIVATE_OTHER_ROUTE'}),true,'BATCH','other');
 const value=await census();
 assert.equal(value.total_rows,7);assert.equal(value.active_rows,5);assert.equal(value.expired_rows,2);
 assert.equal(value.purged_state_not_inspected,true);assert.equal(value.logical_or_wire_size_proved,false);
 const compressed=value.buckets.find(row=>row.expiry==='active'&&row.compression==='pglz');
 assert.equal(compressed.row_count,1);assert.equal(compressed.stored_bytes_le_64k_count,1);
 assert.ok(compressed.stored_bytes_max<65536);
 const active=value.buckets.find(row=>row.expiry==='active'&&row.compression==='none');
 assert.equal(active.row_count,4);assert.equal(active.null_result_count,1);assert.equal(active.stored_bytes_le_64k_count,2);
 assert.equal(active.stored_bytes_le_1m_count,2);assert.equal(active.stored_bytes_gt_1m_count,1);
 const expired=value.buckets.find(row=>row.expiry==='expired'&&row.compression==='none');
 assert.equal(expired.row_count,2);assert.equal(expired.stored_bytes_le_64k_count,1);assert.equal(expired.stored_bytes_le_1m_count,2);
 assert.equal((await db.query('SELECT count(*)::int count FROM app_private.idempotency_records')).rows[0].count,9);
 assert.ok(!JSON.stringify(value).includes('PRIVATE_'));assert.ok(!JSON.stringify(value).includes('11111111'));
 console.log(JSON.stringify(value));
} finally {await db.close();}
