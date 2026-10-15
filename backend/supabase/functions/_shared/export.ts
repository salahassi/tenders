import Decimal from "decimal.js";
import { XMLParser } from "fast-xml-parser";
import { unzipSync } from "fflate";
import { AppError } from "./http.ts";
import { validateOriginal } from "./originals.ts";
import { blockedContent } from "./model.ts";
type Row=Record<string,any>;
export type ExportBlock={type:"paragraph"|"bullet"|"heading"|"title";text:string}|{type:"table";headers:string[];rows:string[][]}|{type:"toc";text:string};
export interface RenderModel {id:string;version:number;mode:string;volume:string;language:string;created_at:string;footer:string;blocks:ExportBlock[];}
const clean=(v:unknown)=>typeof v==="string"?v:"";
export function buildExportModel(request:Row):RenderModel {
 const s=request.snapshot,rtl=s.language==="ar",l=(en:string,ar:string)=>rtl?ar:en,blocks:ExportBlock[]=[];
 const p=(text:string)=>{if(text)blocks.push({type:"paragraph",text});},h=(text:string)=>blocks.push({type:"heading",text});
 p(clean(s.template?.style_config?.company_name));blocks.push({type:"title",text:s.title});p(s.opportunity_title);
 p(`${l("Version","النسخة")} ${s.ordinal} · ${l("Generated","تاريخ الإنشاء")} ${request.created_at}`);
 p(request.mode==="draft"?l("DRAFT — Review before external use","مسودة — تُراجع قبل الاستخدام الخارجي"):l("Approved proposal content","محتوى العرض المعتمد"));
 p(request.volume==="technical"?l("Technical volume","العرض الفني"):request.volume==="financial"?l("Financial volume","العرض المالي"):l("Technical and commercial proposal","العرض الفني والمالي"));
 blocks.push({type:"toc",text:l("Contents","المحتويات")});
 for(const section of s.sections.filter((x:Row)=>request.volume==="combined"||x.volume===request.volume||x.volume==="shared")){
  h(section.title);if(Array.isArray(section.content_blocks)&&section.content_blocks.length)for(const b of section.content_blocks){if(b.type==="table")blocks.push({type:"table",headers:b.headers,rows:b.rows.map((r:string[])=>b.headers.map((_:string,i:number)=>r[i]||""))});else blocks.push({type:b.type==="bullet"?"bullet":"paragraph",text:b.text});}else for(const line of clean(section.body).split("\n"))p(line);
 }
 if(request.volume!=="financial"){
  h(l("Delivery schedule","جدول التسليم"));const d=s.delivery?.calculated;
  if(d){p(`${l("Effort in person-days","الجهد بأيام العمل للفرد")}: ${d.effort_person_days}; ${l("Elapsed working days","المدة بأيام العمل")}: ${d.duration_workdays}`);blocks.push({type:"table",headers:[l("Task","المهمة"),l("Role","الدور"),l("Effort","الجهد"),l("Start","البداية"),l("End","النهاية")],rows:d.tasks.map((t:Row)=>[t.title||t.key,t.role,t.effort_days,t.start_workday,t.end_workday])});}else p(l("[INPUT REQUIRED: approved delivery schedule]","[INPUT REQUIRED: خطة تسليم معتمدة]"));
  h(l("Requirement compliance matrix","مصفوفة الامتثال للمتطلبات"));blocks.push({type:"table",headers:[l("Requirement","المتطلب"),l("Response","الاستجابة"),l("Proposal sections","أقسام العرض")],rows:s.requirements.filter((r:Row)=>request.volume!=="technical"||r.category!=="commercial").map((r:Row)=>{const c=s.compliance.find((x:Row)=>x.requirement_id===r.id);return[r.text,c?.status||l("Not confirmed","غير مؤكد"),(c?.section_keys||[]).join(", ")];})});
 }
 if(request.volume!=="technical"){
  h(l("Commercial schedule","الجدول المالي"));const e=s.estimate,c=e?.calculated;
  if(c){const money=(v:string)=>new Decimal(v).toFixed(c.precision??2,Decimal.ROUND_HALF_UP);p(`${l("Currency","العملة")}: ${c.currency}`);blocks.push({type:"table",headers:[l("Item","البند"),l("Quantity and unit","الكمية والوحدة"),l("Charge","نوع التكلفة"),l("Net","قبل الضريبة"),l("Tax","الضريبة"),l("Total","الإجمالي")],rows:e.input.lines.map((line:Row)=>{const amount=c.lines.find((r:Row)=>r.id===line.id);return[line.description,`${line.quantity} ${line.unit} × ${line.period_count}`,`${line.included_in_base?l("Base","أساسي"):l("Optional","اختياري")} · ${line.charge_group}`,money(amount.net_price),money(amount.tax),money(amount.gross_total)];})});
   blocks.push({type:"table",headers:[l("Offer summary","ملخص العرض"),c.currency],rows:[[l("Base excluding tax","القيمة الأساسية قبل الضريبة"),money(c.net_price)],[l("Tax","الضريبة"),money(c.tax)],[l("Base total","الإجمالي الأساسي"),c.display_gross],[l("Optional items excluded from base","البنود الاختيارية غير المشمولة في الأساسي"),money(c.optional_gross)],[l("Rounding adjustment","فرق التقريب"),c.rounding_adjustment]]});
   h(l("Payment milestones","مراحل الدفع"));p(`${l("Payment basis","أساس احتساب الدفعات")}: ${c.payment_basis}`);blocks.push({type:"table",headers:[l("Milestone","المرحلة"),l("Percent","النسبة"),l("Amount","المبلغ")],rows:c.payments.map((x:Row)=>[x.title,x.percent+"%",x.amount])});p(`${l("Offer valid through","يسري العرض حتى")}: ${e.input.validity_date}`);p(e.input.commercial_terms);
  }else p(l("[INPUT REQUIRED: approved commercial estimate]","[INPUT REQUIRED: تقدير مالي معتمد]"));
 }
 const model={id:request.id,version:s.ordinal,mode:request.mode,volume:request.volume,language:s.language,created_at:request.created_at,footer:clean(s.template?.style_config?.footer),blocks};
 const visible=exportParagraphs(model).join("\n");if(blockedContent(visible))throw new AppError(422,"DATA_POLICY_BLOCKED","Export content requires eligibility review.");
 if(request.mode==="final"&&/\[INPUT REQUIRED/i.test(visible))throw new AppError(422,"EXPORT_BLOCKED","Resolve missing input before final export.");
 if(request.volume==="technical"&&/(?:\b(?:SAR|USD|AED|EUR)\s*[\d]|\d[\d,.]*\s*(?:ريال|دولار))/.test(visible))throw new AppError(422,"TECHNICAL_VOLUME_CONTAINS_PRICE","Review pricing separation before export.");return model;
}
export function exportParagraphs(model:RenderModel):string[]{return model.blocks.flatMap(b=>b.type==="table"?[b.headers,...b.rows].flat():[b.text]).map(normalize).filter(Boolean);}
const normalize=(s:string)=>s.normalize("NFC").replace(/\s+/g," ").trim();
export function verifyExportDocx(bytes:Uint8Array,model:RenderModel){
 validateOriginal("proposal.docx","application/vnd.openxmlformats-officedocument.wordprocessingml.document",bytes);
 let files:Record<string,Uint8Array>;try{files=unzipSync(bytes,{filter:file=>/\.xml$|\.rels$/.test(file.name)});}catch{throw new AppError(422,"INVALID_EXPORT_ARCHIVE","The Word archive is invalid.");}
 const decode=(name:string)=>new TextDecoder("utf-8",{fatal:true}).decode(files[name]||new Uint8Array());
 for(const [name,bytes] of Object.entries(files)){
  const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
  if(/<!DOCTYPE|<!ENTITY|<w:(?:ins|del|commentRangeStart|commentRangeEnd|commentReference)\b/i.test(text)||/TargetMode\s*=\s*["']External["']/i.test(text)||(/comments\d*\.xml$/i.test(name)&&/<w:comment\b/.test(text)))throw new AppError(422,"EXPORT_UNSAFE_CONTENT","Remove tracked changes, comments and external relationships.");
 }
 const parser=new XMLParser({ignoreAttributes:false,preserveOrder:true,processEntities:true,parseTagValue:false,trimValues:false}),xml=decode("word/document.xml"),tree=parser.parse(xml);
 function allText(nodes:any[]):string{return nodes.map(n=>Object.entries(n).filter(([k])=>k!==":@").map(([k,v])=>k==="w:t"&&Array.isArray(v)?v.map(x=>x["#text"]||"").join(""):k==="w:tab"?"\t":k==="w:br"?"\n":k==="w:instrText"?"":Array.isArray(v)?allText(v):"").join("")).join("");}
 const paragraphs:string[]=[];
 function walk(nodes:any[]){for(const n of nodes)for(const [k,v] of Object.entries(n)){if(!Array.isArray(v))continue;if(k==="w:sdt"&&/TOC/.test(JSON.stringify(v))){
 const contents=model.language==="ar"?"المحتويات":"Contents", headings=model.blocks.filter(b=>b.type==="heading").map(b=>(b as {text:string}).text);
 const tocLines:string[]=[];const collect=(nodes:any[])=>{for(const x of nodes)for(const [tag,children]of Object.entries(x)){if(!Array.isArray(children))continue;if(tag==="w:p"){const value=normalize(allText(children.filter((z:any)=>!z["w:pPr"])).replace(/TOC\s+[^]*?$/,""));if(value)tocLines.push(value);}else collect(children);}};collect(v);
 if(tocLines.some(line=>line!==contents&&!headings.some(h=>line===normalize(h)||new RegExp("^"+normalize(h).replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"[ \\t]*[0-9ivxlcdm]*$","i").test(line))))throw new AppError(422,"EXPORT_CONTENT_MISMATCH","The contents table contains unapproved text.");
 paragraphs.push(contents);continue;
}if(k==="w:p"){const text=allText(v.filter((x:any)=>!x["w:pPr"])).replace(/TOC\s+[^]*?$/,"");if(normalize(text))paragraphs.push(normalize(text));}else walk(v);}}
 walk(tree);
 const expected=exportParagraphs(model);
 if(JSON.stringify(paragraphs)!==JSON.stringify(expected))throw new AppError(422,"EXPORT_CONTENT_MISMATCH","Word content does not match the authorized proposal. Generate a new version for content changes.");
 for(const name of Object.keys(files).filter(n=>/^word\/(?:header|footer|footnotes|endnotes)[0-9]*\.xml$/.test(n))){
 const text=normalize(allText(parser.parse(decode(name))));
 if(/^word\/footer/.test(name)){const expected=normalize(model.footer);if(text!==expected&&text!==normalize(expected+" ·")&&!new RegExp("^"+expected.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"(?: · )?[0-9]*$").test(text))throw new AppError(422,"EXPORT_CONTENT_MISMATCH","Unexpected footer content.");}
 else if(text)throw new AppError(422,"EXPORT_CONTENT_MISMATCH","Unexpected header or note content.");
 }
 const props=decode("docProps/core.xml");if(blockedContent(props)||/<(?:dc:creator|cp:lastModifiedBy)>(?!Tenderdesk<)[^<]+</.test(props))throw new AppError(422,"EXPORT_METADATA_REVIEW_REQUIRED","Remove personal author properties before uploading the reviewed file.");
 if(!/<w:updateFields\b/.test(decode("word/settings.xml"))||!/(?:TOC\s|TOC\\)/.test(xml))throw new AppError(422,"EXPORT_FIELDS_MISSING","The Word file must retain live contents and update-fields settings.");
 return true;
}
