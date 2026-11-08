// Real deployed settings startup. Only same-origin GETs; no business writes.
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const resources = new Set(['bootstrap','status','sources','source-runs','opportunities','knowledge','jobs','job-summaries','notifications','proposals','documents','proposal-versions','proposal-sections','questions','review-inputs','regeneration-requests','requirements','fit-assessments','opportunity-discovery','models','providers','model-routing','model-activity','usage','usage-review','settings','memberships','invitations']);
export function category(raw, origin) {
  const url = new URL(raw);
  if (url.origin !== origin) return 'foreign';
  if (url.pathname.startsWith('/functions/v1/api/v1/')) {
    const key = url.pathname.slice('/functions/v1/api/v1/'.length).split('/')[0];
    return resources.has(key) ? key : 'other-api';
  }
  return url.pathname.startsWith('/auth/') ? 'auth' : 'static';
}
export function allowed(raw, method, origin) {
  return new URL(raw).origin === origin && method === 'GET';
}
export async function diagnose(input) {
  if (input.origin !== 'https://tenderdesk.129.212.166.115.sslip.io' || !input.session?.access_token) throw Error('STARTUP_INPUT_INVALID');
  const report = {version:1,kind:'actual_workspace_startup',settings_ready:false,skeleton_visible:false,browser_errors:0,blocked_requests:0,api_requests:0,resources:{},business_mutations:0,model_requests:0};
  const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking']});
  const context = await browser.newContext({serviceWorkers:'block'});
  const started = Date.now();
  let active = true;
  const pending = new Set(), observed = [];
  try {
    await context.addInitScript(({origin,session})=>{if(location.origin===origin)localStorage.setItem(`sb-${new URL(origin).hostname.split('.')[0]}-auth-token`,JSON.stringify(session));},input);
    await context.route('**/*', async route=>{
      const request=route.request(),key=category(request.url(),input.origin);
      if (!active || !allowed(request.url(),request.method(),input.origin) || report.api_requests>=200) {
        report.blocked_requests++;await route.abort();return;
      }
      if (key!=='static' && key!=='auth') {report.api_requests++;observed.push(new URL(request.url()).pathname.split('/').at(-1));}
      await route.continue();
    });
    const page=await context.newPage();
    if(input.observe_model_polls)await page.clock.install();
    page.on('pageerror',()=>report.browser_errors++);
    page.on('response',response=>{
      const key=category(response.url(),input.origin);
      if(key==='static'||key==='auth'||key==='foreign')return;
      const entry=report.resources[key]??={requests:0,records:0,bytes:0,nonempty_pages:0,min_page_size:null,max_page_size:0,statuses:{}};
      entry.requests++;entry.statuses[response.status()]=(entry.statuses[response.status()]||0)+1;
      const task=(async()=>{try {
        const body=await response.body();entry.bytes+=body.length;
        const rows=JSON.parse(body.toString()).data?.records;
        if(Array.isArray(rows)){entry.records+=rows.length;if(rows.length){entry.nonempty_pages++;entry.min_page_size=Math.min(entry.min_page_size??rows.length,rows.length);entry.max_page_size=Math.max(entry.max_page_size,rows.length);}}
      }catch{}})();pending.add(task);task.finally(()=>pending.delete(task));
    });
    const response=await page.goto(input.origin+'/#/settings?section=models',{waitUntil:'domcontentloaded',timeout:15000});
    report.index_sha256=createHash('sha256').update(await response.body()).digest('hex');
    try {await page.getByRole('heading',{name:'Workspace settings',exact:true}).waitFor({state:'visible',timeout:65000});report.settings_ready=true;} catch {}
    if(report.settings_ready){
      try{await page.getByRole('heading',{name:'Models & providers',exact:true}).waitFor({state:'visible',timeout:10000});await page.waitForLoadState('networkidle',{timeout:10000});report.network_settled=true;}catch{report.network_settled=false;}
    }
    if(input.observe_model_polls && report.network_settled){
      report.startup_api_requests=report.api_requests;
      report.startup_elapsed_ms=Date.now()-started;
      report.model_poll_checks=[];
      for(let i=0;i<2;i++){
        const start=observed.length;
        await page.clock.runFor(60001);
        let previous=-1,settled=false;
        for(let attempt=0;attempt<32;attempt++){
          await delay(250);
          if(observed.length>start && previous===observed.length && pending.size===0){settled=true;break;}
          previous=observed.length;
        }
        const reads=observed.slice(start);
        report.model_poll_checks.push({settled,api_requests:reads.length,status_reads:reads.filter(key=>key==='status').length,
          catalog_reads:reads.filter(key=>['model-connections','model-configurations','model-task-routes','model-execution-settings','model-catalog-status'].includes(key)).length,
          business_reads:reads.filter(key=>key!=='status'&&!key.startsWith('model-')).length});
      }
    }
    report.models_visible=await page.getByRole('heading',{name:'Models & providers',exact:true}).isVisible();
    report.skeleton_visible=await page.locator('.shell-skeleton').isVisible();
    report.alert_count=await page.getByRole('alert').count();
    report.elapsed_ms=Date.now()-started;
  } finally {active=false;await context.close();await Promise.allSettled([...pending]);await browser.close();}
  return report;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  let raw='';for await (const chunk of process.stdin)raw+=chunk;
  try{console.log(JSON.stringify(await diagnose(JSON.parse(raw))));}catch{console.log(JSON.stringify({version:1,kind:'actual_workspace_startup',error:'STARTUP_BROWSER_FAILED'}));process.exitCode=1;}
}
