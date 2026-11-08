// Isolated real Chromium toggle/poll/navigation regression. No external requests.
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {readFile, mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const {chromium}=createRequire(path.join(root,'backend/package.json'))('playwright');
const dist=process.env.TENDERDESK_BROWSER_DIST||path.join(root,'frontend/dist');
const origin='https://models-regression.test', wid='00000000-0000-4000-8000-000000000010';
const user={id:wid,aud:'authenticated',role:'authenticated',email:'fixture@example.test',app_metadata:{},user_metadata:{},created_at:'2026-01-01T00:00:00Z'};
const enc=v=>Buffer.from(JSON.stringify(v)).toString('base64url'), exp=Math.floor(Date.now()/1000)+3600;
const session={access_token:`${enc({alg:'HS256',typ:'JWT'})}.${enc({sub:wid,exp,aud:'authenticated',role:'authenticated'})}.fixture`,refresh_token:'fixture',expires_at:exp,expires_in:3600,token_type:'bearer',user};
const connection={id:wid,provider:'openai',label:'Isolated connection',credential_alias:'APP_MODEL_OPENAI_KEY',project_ref:'default',enabled:true,revision:1};
const model={id:wid,connection_id:wid,label:'Isolated model',model:'fixture-model',enabled:true,revision:1,capabilities:{revision:1,output:'validated_json',background:false,streaming:true,reasoning:'none',reasoning_values:[],max_output_tokens:null}};
let token='initial'; const requests=[],violations=[],errors=[];
const lists=new Set(['sources','source-runs','opportunities','knowledge','job-summaries','notifications','proposals','documents','proposal-versions','proposal-sections','questions','review-inputs','regeneration-requests','requirements','fit-assessments','opportunity-discovery','model-activity']);
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':chromium.executablePath()),headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking']});
const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:1000}});
try {
 await context.addInitScript(({origin,session})=>{if(location.origin===origin)localStorage.setItem('sb-models-regression-auth-token',JSON.stringify(session));},{origin,session});
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),key=url.pathname.split('/').at(-1);
  const json=data=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data,meta:{request_id:'fixture'}})});
  if(url.origin!==origin){violations.push('foreign');return route.abort();}
  if(url.pathname.startsWith('/functions/'))requests.push({key,method:req.method()});
  if(req.method()==='POST'&&key==='commands'){
   const commands=req.postDataJSON().commands;
   assert.equal(commands.length,1);const {operation,input}=commands[0];
   assert(['model.connection.save','model.configuration.save'].includes(operation));
   const row=operation==='model.connection.save'?connection:model;
   assert.equal(input.expected_revision,row.revision);
   Object.assign(row,input,{revision:row.revision+1});token=`saved-${requests.length}`;
   return json([{...row}]);
  }
  if(req.method()!=='GET'){violations.push('mutation');return route.abort();}
  if(url.pathname==='/runtime-config.js')return route.fulfill({contentType:'application/javascript',body:`window.__TENDERDESK_CONFIG__=${JSON.stringify({apiUrl:origin,publishableKey:'fixture',appOrigin:origin})};`});
  if(url.pathname==='/auth/v1/user')return route.fulfill({contentType:'application/json',body:JSON.stringify(user)});
  if(key==='status')return json({change_token:token,last_heartbeat_at:null,last_source_success_at:null,scheduler_enabled:false});
  if(key==='bootstrap')return json({membership:{user_id:wid,workspace_id:wid,role:'Owner'},workspace:{id:wid,revision:1,name:'Isolated settings fixture',settings:{}},operations:null});
  if(key==='model-catalog-status')return json({connections:[{id:wid,key_configured:true}],tasks:[]});
  if(key==='model-routing'||key==='model-settings')return json({records:[]});
  if(key==='model-environment')return json({providers:[]});
  if(key==='model-connections')return json({records:[connection],next_cursor:null});
  if(key==='model-configurations')return json({records:[model],next_cursor:null});
  if(key==='model-task-routes'||key==='model-execution-settings')return json({records:[],next_cursor:null});
  if(lists.has(key))return json({records:[],next_cursor:null});
  const relative=url.pathname==='/'?'index.html':url.pathname.slice(1);
  if(!/^(index\.html|favicon\.svg|assets\/[a-zA-Z0-9_./-]+)$/.test(relative)||relative.includes('..')){violations.push(key);return route.abort();}
  const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2'};
  return route.fulfill({contentType:mime[path.extname(relative)]||'application/octet-stream',body:await readFile(path.join(dist,relative))});
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 // Advance application timers explicitly; no 60-second wall-clock sleep.
 await page.clock.install();
 const settle=async()=>{let previous=-1;for(let n=0;n<40;n++){await delay(250);if(previous===requests.length)return;previous=requests.length;}throw Error('REQUESTS_DID_NOT_SETTLE');};
 await page.goto(origin+'/#/settings?section=models');
 await page.getByText('fixture-model',{exact:true}).waitFor();
 await settle();
 const startup=requests.length;
 let start=requests.length;
 await page.clock.runFor(60001);await settle();
 assert.deepEqual(requests.slice(start).map(r=>r.key),['status'],'FIRST_POLL_MUST_NOT_RELOAD_WORKSPACE');
 const saves=[];
 for(const kind of ['connection','model'])for(const enabled of [false,true]){
  start=requests.length;
  await page.getByRole('button',{name:'Edit',exact:true}).nth(kind==='connection'?0:1).click();
  await page.getByRole('checkbox',{name:'Enabled',exact:true}).setChecked(enabled);
  await page.getByRole('button',{name:`Save ${kind}`,exact:true}).click();
  await page.getByRole('button',{name:`Save ${kind}`,exact:true}).waitFor({state:'hidden'});
  await settle();
  const reads=requests.slice(start);
  assert.equal(reads.length,6,'SAVE_REQUEST_COUNT');
  assert.equal(reads.filter(r=>r.method==='POST').length,1);
  assert(reads.every(r=>r.key==='commands'||r.key.startsWith('model-')),'SAVE_LOADED_BUSINESS_HISTORY');
  assert.equal((kind==='connection'?connection:model).enabled,enabled);
  saves.push({kind,enabled,requests:reads.length});
 }
 start=requests.length;await page.clock.runFor(60001);await settle();
 assert.equal(requests.length-start,6,'CHANGED_POLL_CATALOG_ONLY');
 assert(requests.slice(start).every(r=>r.key==='status'||r.key.startsWith('model-')));
 start=requests.length;await page.clock.runFor(60001);await settle();
 assert.deepEqual(requests.slice(start).map(r=>r.key),['status'],'UNCHANGED_POLL_MUST_SETTLE');
 const screenshots=path.join(process.env.RUNNER_TEMP||'/tmp','tenderdesk-model-settings');await mkdir(screenshots,{recursive:true});
 await page.screenshot({path:path.join(screenshots,'models-after-toggles.png'),fullPage:true});
 start=requests.length;await page.getByRole('link',{name:'Activity & jobs'}).click();
 await page.getByRole('heading',{name:'Activity & jobs',exact:true}).waitFor();await settle();
 assert.equal(requests.slice(start).filter(r=>r.key==='bootstrap').length,1,'NAVIGATION_REFRESH_ONCE');
 assert.equal(requests.slice(start).filter(r=>r.key==='job-summaries').length,1);
 assert.deepEqual(violations,[]);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({kind:'model_settings_browser_fixture',status:'passed',startup_requests:startup,saves,first_poll_requests:1,changed_poll_requests:6,unchanged_poll_requests:1,navigation_bootstrap_requests:1,external_requests:0,model_requests:0}));
} finally {await context.close();await browser.close();}
