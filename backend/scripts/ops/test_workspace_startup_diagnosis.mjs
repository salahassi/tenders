import test from 'node:test';
import assert from 'node:assert/strict';
import {allowed,category} from './workspace-startup-diagnosis.mjs';
const origin='https://tenderdesk.129.212.166.115.sslip.io';
test('browser refuses mutations and every foreign destination',()=>{
  for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal(allowed(origin+'/functions/v1/api/v1/commands',method,origin),false);
  assert.equal(allowed('https://foreign.test/','GET',origin),false);
  assert.equal(allowed(origin+'/functions/v1/api/v1/bootstrap','GET',origin),true);
});
test('public report categories discard customer identifiers and query values',()=>{
  assert.equal(category(origin+'/functions/v1/api/v1/jobs/private-id?cursor=private-id',origin),'jobs');
  assert.equal(category(origin+'/functions/v1/api/v1/customer-secret',origin),'other-api');
  assert.equal(category('https://foreign.test/private',origin),'foreign');
});
