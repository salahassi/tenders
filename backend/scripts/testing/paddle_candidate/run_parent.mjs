// Actual product parent, synthetic gateway, and explicitly experimental reader.
// This file receives only one synthetic PDF/request; no gold is mounted.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
const started=Date.now(),deadline=started+90000;
const sha=(data)=>createHash('sha256').update(data).digest('hex');
const exec=promisify(execFile);
const config=JSON.parse(await readFile('/experiment/experiment-config.json','utf8'));
if(config.page_attempt_seconds!==90)throw Error('Frozen page deadline changed');
const request=JSON.parse(await readFile('/inputs/request.json','utf8'));
const {processUploadedDocumentOcr}=await import('/app/backend/scripts/backend/uploaded-document-ocr-worker.ts');
const input=await readFile('/inputs/source.pdf');
const output='/outputs';
const scratch='/tmp/a06-attempt';
await mkdir(scratch,{recursive:false});
let completion=null;
const calls=[];
const nativeEnv={PATH:'/usr/local/bin:/usr/bin:/bin:/opt/paddle/bin',LANG:'C.UTF-8',
  OMP_THREAD_LIMIT:'1',OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',NUMEXPR_NUM_THREADS:'1',
  PYTHONDONTWRITEBYTECODE:'1',XDG_CACHE_HOME:'/tmp/a06-cache',
  PADDLE_PDX_CACHE_HOME:'/tmp/a06-paddlex',PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK:'True',
  HF_HOME:'/tmp/a06-hf',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',MODELSCOPE_CACHE:'/tmp/a06-modelscope'};
async function command(binary,args,cap){
  const remaining=deadline-Date.now();
  if(remaining<=0)throw Error('DOCUMENT_OCR_TIMEOUT');
  try{return await exec(binary,args,{timeout:Math.min(cap,remaining),killSignal:'SIGKILL',
    maxBuffer:4*1024*1024,env:nativeEnv});}
  catch(error){
    await writeFile(`${output}/native-failure.json`,JSON.stringify({binary,code:error.code,
      signal:error.signal,killed:error.killed,stdout:String(error.stdout??'').slice(-65536),
      stderr:String(error.stderr??'').slice(-65536)},null,2),{flag:'wx'});
    throw Error(error.killed?'DOCUMENT_OCR_TIMEOUT':'DOCUMENT_OCR_FAILED');
  }
}
async function experimentalRead(bytes,task){
  if(bytes.length<5||bytes.length>config.max_original_bytes||bytes.subarray(0,5).toString()!=='%PDF-'||
     sha(bytes)!==task.original_hash||!Number.isInteger(task.total_pages)||task.total_pages<1||
     task.total_pages>config.max_pdf_pages||!Number.isInteger(task.page)||task.page<1||task.page>task.total_pages)
    throw Error('DOCUMENT_OCR_CAPACITY');
  const pdf=`${scratch}/source.pdf`,prefix=`${scratch}/page`;
  await writeFile(pdf,bytes,{mode:0o600});
  const info=await command('/usr/bin/pdfinfo',[pdf],10000);
  if(/^Encrypted:\s+yes/m.test(info.stdout))throw Error('DOCUMENT_OCR_RESTRICTED');
  if(Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1])!==task.total_pages)throw Error('DOCUMENT_OCR_SOURCE_CHANGED');
  await command('/usr/bin/pdftoppm',['-f',String(task.page),'-l',String(task.page),'-scale-to','2000','-png','-singlefile',pdf,prefix],25000);
  const image=await readFile(prefix+'.png');
  if(image.length<24||image.length>20*1024*1024||image.readUInt32BE(16)>2000||image.readUInt32BE(20)>2000)
    throw Error('DOCUMENT_OCR_CAPACITY');
  await writeFile(`${output}/input-raster.png`,image,{flag:'wx'});
  await command('/opt/paddle/bin/python',['/experiment/run_engine.py',prefix+'.png',output],90000);
  const raw=JSON.parse(await readFile(`${output}/raw-engine.json`,'utf8'));
  if(raw.engine!=='paddle_static'||raw.source_image_sha256!==sha(image)||
     !Array.isArray(raw.result.rec_texts)||!raw.result.rec_texts.every(v=>typeof v==='string'))
    throw Error('DOCUMENT_OCR_FAILED');
  const text=raw.result.rec_texts.join('\n').trim();
  const projected={page:task.page,text,confidence:0,image_hash:sha(image),text_hash:sha(text),
    engine:'experimental_paddle_static',engine_version:`PaddleOCR${raw.paddleocr_version}/Paddle${raw.paddle_version}`,
    languages:['ar'],numeric_uncertainty:true,recognition_uncertainty:true};
  await writeFile(`${output}/node-projection.json`,JSON.stringify({projection:projected,
    projection_operation:'rec_texts.join(newline).trim()',model_confidence_not_calibrated_for_product:true,
    production_engine_schema_unchanged:true},null,2),{flag:'wx'});
  return projected;
}
async function gateway(action,payload){
  calls.push(action);
  if(action==='uploaded_ocr_claim')return {action:'recognize',request_id:'synthetic-a06',lease:'isolated',...request};
  if(action==='uploaded_ocr_input')return {bytes:input.toString('base64')};
  if(action==='uploaded_ocr_complete'){completion=payload;return {};}
  throw Error('Unexpected synthetic gateway action');
}
try{
  await processUploadedDocumentOcr(gateway,experimentalRead);
  const finalCgroup={};
  for(const name of ['memory.current','memory.peak','memory.events','memory.swap.current','memory.swap.peak','memory.max','memory.swap.max','cpu.max'])
    finalCgroup[name]=(await readFile('/sys/fs/cgroup/'+name,'utf8')).trim();
  await writeFile(`${output}/parent-receipt.json`,JSON.stringify({scope:'actual_product_parent_with_synthetic_gateway_and_experimental_reader',
    actual_processUploadedDocumentOcr_invoked:true,default_tesseract_reader_invoked:false,
    production_gateway_called:false,customer_or_provider_calls:0,calls,elapsed_ms:Date.now()-started,
    error_code:completion?.error_code??null,result_present:!!completion?.result,
    result_engine:completion?.result?.engine??null,node_version:process.version,
    pid:process.pid,ppid:process.ppid,cgroup:await readFile('/proc/self/cgroup','utf8'),
    parent_memory_final:process.memoryUsage(),cgroup_final:finalCgroup},null,2),{flag:'wx'});
  if(completion?.error_code||!completion?.result)process.exitCode=1;
}finally{await rm(scratch,{recursive:true,force:true});}
