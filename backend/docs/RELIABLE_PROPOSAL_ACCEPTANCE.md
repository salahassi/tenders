# ملحق القبول الهندسي: صحة المحتوى واستمرارية تسليم العرض

التاريخ: 4 نوفمبر 2026. هذا الملحق جزء من [خطة التنفيذ](RELIABLE_PROPOSAL_DELIVERY_PLAN.md).
**حالة التنفيذ متغيرة بحسب الحالة الفرعية.** نُفذت أجزاء واختبارات محلية، وما زال النشر والقبول المتصل مفتوحين.
يعرض [سجل التنفيذ](IMPLEMENTATION_CHECKLIST.md) الأدلة المرتبطة بالمراجعات الفعلية، وتعرض
[مراجعة الإغلاق المستقلة](evidence/reliability-closure-audit-20261104.json) الفجوات عند المراجعة المثبتة فيها.
أعداد اختبارات خط الأساس لا تُحسب قبولًا تلقائيًا للحالات الجديدة، ولا تُجمع نتائج فروع مختلفة بوصفها نتيجة إصدار واحد.

المطلوب إثباته: طلب تقديم عروض (Request for Proposal — RFP) صالح ينتج استجابة مفيدة خاصة بالمناقصة؛
المدخل الفارغ أو غير القابل للاستخدام تمامًا ينتج قالبًا محفوظًا مع مواضع تعبئة (Placeholders) صفراء وتنبيه صحيح.
وجود ملف، أو استجابة HTTP ناجحة، أو قائمة معرفات «تمت معالجتها»، لا يثبت صحة المعنى أو اكتمال العرض.
مخرج مؤقت أثناء تعطل النماذج لا يُعرض بوصفه عرضًا مكتملًا. وفق قرار المالك اللاحق D06، غياب جميع الوكلاء يعيد خطأ واضحًا فورًا؛ ولا يُشترط مسار إكمال بشري بديل.

## 1. حدود الإثبات وسياسة التنفيذ

- النتيجة المرجعية المستقلة (Test oracle) تُكتب من المصدر قبل تشغيل النظام، وتراجع دلاليًا بواسطة مراجعين فعليين؛ يحسم اختلافهما قبل تجميد الحالة.
- تستخدم البيانات الاصطناعية داخل الاختبارات والبيئة المعزولة فقط. لا مستندات عملاء أو مفاتيح أو إيصالات خاصة بنصها في GitHub أو سجل CI عام.
- حقن الأعطال (Fault injection) يكون في بيئة معزولة. التجربة الحية في الإنتاج تختار طلبًا حقيقيًا مصرحًا به، دون تعطيل خدماته أو إدخال سجلات تجريبية.
- لا تعيد الاختبارات سقوف استدعاء/توكنات يومية تطبيقية للتوجيه التلقائي، أو إقرار فوترة، أو استدعاء عدّ توكنات بعيد، أو تعليقًا دائمًا بسبب استهلاك مجهول.
- حدود حملة التقييم المعزولة ليست سياسة منتج. تبقى صلاحيات المحتوى، وهوية الطلب المدفوع، وحدود الطلب والتصحيح المثبتة، واستهلاك غير مبلغ عنه محفوظًا كغير معلوم.
- لا تغير إعداد فوترة أو `free-only` تلقائيًا. تفسر حصة المزود وفق نطاقها الحقيقي؛ حساب واحد متوقف لا يُتجاوز بتغيير اسم النموذج على الحساب نفسه.
- لا يُفترض هدف زمني أو سعة أو دقة أو ميزانية. تُحسم D01–D07 في الخطة الرئيسية قبل قبول القياسات المرتبطة بها؛ حد 600 ثانية وسلوك D06 محسومان بقرار المالك، وإثبات تطبيقهما وبقية القيم يبقى مطلوبًا.
- انتهاء مخصص التصحيح المثبت لمرشح أو حد حملة تجريبية لا ينشئ سقف كلفة أو قطعًا دائمًا للإثراء التلقائي؛ الاستمرار والاستعادة يتبعان السياسة القائمة وهوية العمليات.
- لا تتجاوز صلاحية المصدر أو العضوية لتحقيق إتاحة الملف. المنع التفويضي أو الانقطاع الشامل حادث/قيد مستقل، وليس دليلًا على عدم صحة RFP.

## 2. الحالات الأم T01–T20

هذه المعرفات ثابتة وتطابق الخطة الرئيسية. المتغيرات التفصيلية أدناه توسعها ولا تعيد تعريف نجاحها.

| المعرف | الحالة الأم | الإثبات المطلوب والمتغيرات |
| --- | --- | --- |
| T01 | RFP صالح ينتج عرضًا جوهريًا | استجابة فعلية وتغطية ومصدر وملف؛ AR-01–03، ME-01/02/08/09/14، RT-01، UX-02/03 |
| T02 | نقص بيانات الشركة أو الأسعار | الحفاظ على النطاق، المجهول لا يصبح صفرًا أو ادعاءً؛ AR-03، ME-04/08، RT-01، EX-06 |
| T03 | فارغ أو تالف أو مرجع غير ذي صلة | قالب بسبب صحيح فقط عند غياب سياق صالح؛ IN-01/02/05، UX-01/03 |
| T04 | مستند مختلط وصفحات فارغة | حفظ كل جزء مقروء وعدم إسقاط المستند كله؛ IN-04، AR-03 |
| T05 | RFP ممسوح وتعطل OCR | استكمال التعرف الضوئي على الحروف (Optical Character Recognition — OCR) دون وصف المدخل الصحيح بأنه فاسد؛ IN-03/06، IN-02 |
| T06 | جميع المزودين متعطلون | خطأ عدم إتاحة الوكلاء فورًا، وحفظ المقبول دون نجاح كاذب، وحد 600 ثانية يشمل الطلب؛ AR-02، ME-07/10/11، BC-01 |
| T07 | عطل عند كل مرحلة | حفظ المقبول واستمرار التسليم والتصنيف الصحيح؛ AR-01–03، ME-07، EX-01، OP-05 |
| T08 | أخطاء متعددة وإصلاح محدد | جميع التشخيصات، مواضع مصدر صحيحة، تعديل محدود وفحص كامل؛ ME-03/05/06/07 |
| T09 | سلطة المصدر والنفي والشروط | الإلزام والفاعل والشرط والاستثناء والوحدة وأسبقية الملاحق محفوظة؛ ME-01/02/04/06/08/09، RT-02 |
| T10 | طلب مقبول واستهلاك مجهول | منع إرسال مكرر مع معالجة تلقائية منضبطة، دون تعليق دائم أو تصفير؛ ME-10/11/12، OP-01 |
| T11 | إغلاق المتصفح وموت العامل والإعادة | عملية تصدير دائمة تستأنف عند كل حد؛ EX-01/02/03، AR-01، UX-01 |
| T12 | تغير المصدر أو سحب التفويض | حفظ تاريخ النسخ ومنع استخدام/كشف مصدر غير مسموح؛ IN-04، AR-04، ME-03/11/12/13 |
| T13 | Word والتظليل والعربية والخطوط والفهرس | كل نقص ظاهر وأصفر، بايتات وبنية وصفحات سليمة؛ EX-06، UX-02/03 |
| T14 | السعة وحدود المعالجة | قبول منضبط وإعادة تنزيل بلا حجوزات مكررة واستعادة حقيقية؛ IN-06، EX-04، OP-02 |
| T15 | إعادة التوليد والاعتماد | لا اعتماد قديم أو ضياع مدخلات؛ AR-05، OP-03، ME-12، UX-02 |
| T16 | استرجاع الأدلة وصلاحياتها | استرجاع الدليل المناسب دون استنتاج غياب قدرة من فشل البحث؛ RT-01/02، ME-01/04/09/13 |
| T17 | الحمل وعدالة الطابور والصيانة | لا تجويع تسليم محلي بسبب النماذج أو صيانة غير حرجة؛ OP-05، EX-01، OP-02 |
| T18 | الاستعادة | ملفات وعلاقات وأذونات ومحاسبة محفوظة، بلا إعادة مدفوعة ملتبسة؛ OP-04، ME-11/12، OP-05 |
| T19 | تعليمات خبيثة داخل المصدر | المصدر بيانات لا سلطة تنفيذ؛ إصلاح/تحقق لا يوسع التفويض؛ ME-05/06/08/13/14 |
| T20 | حزمة الأجزاء وتعديل بشري متزامن | فني ومالي من لقطة واحدة، وعدم الكتابة فوق المستخدم؛ EX-05، AR-05، OP-03 |

## 3. مصفوفة التتبع F → W → T → الحالات التفصيلية

| الفجوة | حزم التنفيذ | الحالات الأم | الحد الأدنى للتفاصيل الملزمة |
| --- | --- | --- | --- |
| F01 | W01/W03/W04/W10 | T01/T06/T07/T11 | AR-01/02/03، EX-01/02، BC-01، UX-03 |
| F02 | W01/W02/W03/W04 | T03/T05 | IN-01/02/03/05، EX-06، UX-01/03 |
| F03 | W02/W05 | T04/T05/T12 | IN-03/04/06، ME-03، AR-04 |
| F04 | W01/W02/W07/W09 | T03–T07/T14 | IN-01–06، AR-02، ME-07/10، OP-02 |
| F05 | W05/W06 | T08/T09/T19 | ME-03/05/06/07/13 |
| F06 | W05/W06/W08 | T01/T09/T16/T19 | ME-01/02/04/08/09/13/14، RT-01/02 |
| F07 | W01/W03/W04/W09 | T11–T15/T20 | EX-01–06، AR-04/05، OP-02/03، UX-01–03 |
| F08 | W03/W07/W09/W10 | T06/T07/T10/T17/T18 | ME-07/11/12، AR-02/03، OP-01/04/05، BC-01 |
| F09 | W08 | T01/T02/T16 | RT-01/02، ME-04/08/09/14 |
| F10 | W07/W09 | T06/T10 | ME-10/11، AR-02، UX-01 |
| F11 | W09 | T07/T17/T18 | OP-05، EX-01، OP-04 |

تُربط نتيجة كل متغير أيضًا بطلب التغيير وبصمة النشر وإيصال القبول. لا يغلق نجاح حالة واحدة
الفجوة إذا بقي متغير فرعي غير مجرب، مثل المراجع من العائلة نفسها أو صفحة عربية لم تُقرأ.

## 4. مستويات التنفيذ والإيصال المشترك

| المستوى | التنفيذ | حدود الدليل |
| --- | --- | --- |
| L1 | وظائف وعقود ومحلل/مُنشئ فعلي مع مصادر اصطناعية ونتيجة مستقلة | لا يثبت خدمات مستضافة أو صلاحيات جلسة فعلية |
| L2 | قاعدة مطبق عليها سجل الترحيلات بالكامل، أوامر وأدوار وسجل تدقيق؛ PostgreSQL لاختبارات القفل والتزامن | PGlite مناسب للرجوع المحلي، وليس إثبات تزامن/تشغيل الإنتاج |
| L3 | API وعامل وتخزين ومُنشئ في بيئة معزولة مع تحكم بالأعطال والساعة | لا يعني وجود مزود حي إلا إذا سُجل استدعاؤه فعليًا |
| L4 | متصفح فعلي وجلسة مسموحة وتنزيل مستقل | البيئة المعزولة أولًا؛ الإنتاج لعينة حقيقية مختارة دون حقن أعطال |
| L5 | تحويل Word وفحص كل صفحة بالعربية والإنجليزية والجداول الطويلة | XML ولقطة شاشة واحدة لا يكفيان لإثبات جودة جميع الصفحات |
| LM | تقييم نموذج حي مؤهل على المهام والإصدارات والمسارات المحددة | تجربة لاحقة محدودة؛ عدم التوافر ليس نجاحًا دلاليًا |

**R0 — إلزامي لكل حالة:** case/variant ID، fixture/hash، commit، بصمات الترحيلات والصور، البيئة والمستوى،
إصدارات العقد والتعليمات والتحقق والتطبيع والمُنشئ والقالب، هوية النموذج/العائلة والمسار عند انطباقها،
جدول العطل والساعة، الحالة قبل وبعد، معرفات التدقيق، expected/actual، مصدر/مرشح/لقطة/حزمة/ملف hashes،
أحجام البايتات، عدد النواقص، زمن التنفيذ مقابل الهدف المثبت، عدد POST/poll، الاستهلاك المعروف والمجهول،
حالة التنظيف، مراجعة بشرية مسماة فعليًا حيث تلزم، ومكان الإيصال الخاص وبصمته.
النصوص الحقيقية والأجسام الخام والمفاتيح لا تظهر في الإيصال العام. غياب حالة أو إيصال مطلوب يفشل التغطية.

حقول `D_delivery` و`D_render` و`N_render` في الاختبارات تعني القيم التي يثبتها D01/D02/D04؛
ليست وعدًا مخترعًا. الحدود المثبتة من سياسة حالية تُختبر كما هي، عند/قبل/بعد الحد، مع توثيق مصدرها.

## 5. الأدوات الموجودة مقابل العمل الجديد

المسارات في هذه الجداول من جذر المستودع. جميع الملفات الجديدة المسماة لاحقًا **مقترحة** حتى إضافتها ومراجعتها.

| الحزمة الاختبارية | الموجود وإعادة الاستخدام | الجديد المطلوب |
| --- | --- | --- |
| الإدخال | `frontend/src/lib/documentWorker.test.ts`؛ `backend/tests/backend/flexibleProposalInputs.test.ts`، `flexibleInputDraftRuntime.test.ts`، `contentEligibility.test.ts`، `httpDatabase.integration.test.ts` | تقييم إدخال وصفحات/OCR ونتيجة قالب محفوظة، وملفات ممسوحة حقيقية اصطناعية |
| عقود الأدلة | `modelAnalysisVerification.test.ts`، `modelGrounding.test.ts`، `modelStructuralReferences.test.ts`، `modelCompanyClaims.test.ts` داخل `backend/tests/backend/` | span resolver وسلطة/إلزام وأسبقية ملاحق ذات إصدار |
| الإصلاح | `modelValidationDiagnostics.test.ts`، `modelContentRepair.test.ts`، `modelGraph.test.ts`، `modelWriterValidationHandoff.integration.test.ts` | جامع أخطاء من المدقق الحقيقي وعقد patch وإغلاق اعتماديات |
| المزود والاستعادة | `roundRobin.test.ts`، `modelRuntime.test.ts`، `modelPolicy.test.ts`، `modelPayloadDiagnostics.test.ts`، `modelVerifierRecheck.integration.test.ts`، `modelAlternateWriterRecovery.integration.test.ts` | جدول استعادة متوافق مع السياسة، تاريخ/ساعة/تزامن، وتصنيف نطاق الحصة |
| الملف | `exportDraft.test.ts`، `proposalExportStructure.test.ts`؛ `frontend/src/test/exportRenderer.test.ts` و`fixtures/exportModels.ts` | typed placeholders، مُنشئ خادمي دائم، تحقق التظليل وحزمة ذرية منطقيًا |
| التشغيل | `database.test.ts`، `operations.test.ts`، `recovery.test.ts`، `continuousModel.test.ts` | قبول/حجز تسليم واستعادة حدود المُنشئ وعزل الصيانة وعدالة فئة التسليم |
| القبول المتصل | `backend/scripts/ops/proposal-export-acceptance.py` و`.mjs` و`.d.mts` و`proposal-export-selection.sql`؛ `.github/workflows/accept-actual-proposal-export.yml` | عقد قبول مستقل للمسودة المبكرة؛ تبقى شروط العرض المكتمل الحالية سليمة |
| تقييم النماذج | `backend/scripts/ops/live-model-evaluation.mjs` و`live-model-evaluation-authority.mjs` و`live-model-evaluation-verification.mjs` | توسيع مُقَيّم الدلالة والمهام وفق corpus مجمد؛ المؤشرات الحالية لا تثبت جودة عرض كامل |

## 6. مواصفات النماذج والأدلة ME-01–ME-14

كل فقرة تحدد fixture/oracle، موقع العطل، الفعل، الموجب والممنوع والإيصال والمستوى؛ لا تُنفذ أثناء كتابة الخطة.

### ME-01 — Buyer authority is separate from the uploaded document label
- **Parent / level:** T01/T09/T16; L1/L2, later LM. Extend `modelAnalysisVerification.test.ts` and `modelGrounding.test.ts`.
- **Fixture / oracle:** identical “supplier must deliver an operations manual” in confirmed buyer RFP, previous vendor proposal and unconfirmed reference; all may have upload kind `rfp`.
- **Fault / action:** inject model output marking all three mandatory buyer obligations; execute versioned authority validation and migrated persistence.
- **Require:** buyer mandate retains its strength/source span; vendor proposal stays proposed; unknown provenance yields a precise gap while useful reference content survives.
- **Forbid:** file-kind or model confidence establishes authority, missing answer becomes confirmed, model grants approval, or missing company proof weakens buyer obligation.
- **Receipt:** R0 plus provenance/authority/modality tuple, rejected field paths and persisted requirement-state diff; provenance oracle independently reviewed.

### ME-02 — Modality, negation, conditions, actors and consequences
- **Parent / level:** T01/T09; L1/L2 and LM. Extend semantic/analysis/grounding tests and independently labeled bilingual corpus.
- **Fixture / oracle:** must/may/must-not, 30 days after approval, only-if-phase-two, legally-required-retention exception; Arabic equivalents; faithful controls plus one-change mutations of actor, trigger, exception, day/month and consequence.
- **Fault / action:** replay writer/verifier candidates through the canonical guarded executor; retain original-language quotation for translated response.
- **Require:** each obligation retains actor/strength/negation/condition/exception/value/unit/consequence and its association; accept faithful paraphrases and translations.
- **Forbid:** keyword or matching-number checks accept changed meaning; all processed IDs hide missing clauses; absent company evidence lowers a known buyer mandate.
- **Receipt:** R0 plus expected/actual semantic tuples, per-class false acceptance/rejection and field-path findings; no averaged score hides critical mutation acceptance.

### ME-03 — Immutable source spans and Arabic coordinates
- **Parent / level:** T08/T12; L1/L2. Extend structural-reference/extraction tests; proposed source-span resolver tests are new.
- **Fixture / oracle:** combining marks, Arabic/Persian digits, emoji before quote, CRLF/NBSP/bidi marks, composed/decomposed Unicode, PDF line break and adjacent table cells; immutable original bytes and normalization map.
- **Fault / action:** select valid/stale/forged span IDs and out-of-range/reversed/surrogate-splitting ranges; specify coordinate convention explicitly and test UTF-8/UTF-16/code-point conversion.
- **Require:** server materializes exact original substring; normalized positions round-trip; disjoint passages stay separate; source/extraction/normalization versions bind every reference.
- **Forbid:** model quote overrides canonical text, wrong source/row joins, normalization erases negation or changes digit meaning, silent repinning of historical references.
- **Receipt:** R0 plus original/normalized/quote hashes, coordinate units, ranges, recorded property-test seed and round-trip/invalid-reference results.

### ME-04 — Authentic quotation does not establish semantic support
- **Parent / level:** T02/T09/T16; L1/L2/LM. Extend grounding/company-claims/structural-reference tests.
- **Fixture / oracle:** “optional workshop lasts 5 days” versus candidate “mandatory”; genuine unrelated quote containing 5; company style sample presented as certification; supported controls.
- **Fault / action:** first resolve canonical quote, then execute semantic and company-evidence checks using accurate and malformed verifier reports separately.
- **Require:** lexical validity and semantic entailment have independent verdicts; supported optional clause passes; only current verified company evidence supports actual credentials.
- **Forbid:** real quotation/numeral proves contradiction, style evidence proves capability, malformed report clears a candidate defect, syntactic acceptance bypasses meaning checks.
- **Receipt:** R0 plus paired lexical/semantic verdicts and evidence-role tuple; every seeded unsupported material claim remains unaccepted.

### ME-05 — Collect all bounded diagnostics and expose overflow
- **Parent / level:** T08/T19; L1/L2. Extend `modelValidationDiagnostics.test.ts`, `modelContentRepair.test.ts`, `modelGraph.test.ts` through actual validators.
- **Fixture / oracle:** four invalid quotes over two requirements, plus independent wrong-role/missing-source/coverage faults; B−1/B/B+1 defects and P−1/P/P+1 paths using exported bounds (current utility B=32, P=16).
- **Fault / action:** run real validation, assemble repair context and apply a three-of-four fix; include duplicate defects and oversized diagnostic path text.
- **Require:** all four initially supplied, stable order/deduplication, exact omitted count, visible unresolved remainder and count conservation; next validation cannot lose overflow.
- **Forbid:** first thrown error hides siblings, utility-only test claims validator completeness, truncated identifier changes identity, omitted errors imply fully reviewed, raw source/provider text leaks.
- **Receipt:** R0 plus discovered/emitted/omitted/deduplicated counts, ordered path hash, unresolved counts and candidate identity; utility's existing 40→32 test is only baseline.

### ME-06 — Scoped patch and justified dependency expansion
- **Parent / level:** T08/T09/T19; L1/L2. Extend content-repair and writer-handoff integration; patch schema and validator are new.
- **Fixture / oracle:** supported obligation/quantity, company uncertainty and two bad refs; malicious patch flips mandatory, deletes clause, changes price or replaces whole candidate; dependent-quantity correction legitimately affects text/span/calculated value.
- **Fault / action:** submit patch with base hash, stable unit IDs and allowed paths; reorder arrays, change base, request justified/unrelated scope expansion; server applies accepted patch then validates complete candidate.
- **Require:** untouched hashes stable, dependency closure explicitly justified, derived arithmetic recalculated conventionally, new candidate/hash/history preserved.
- **Forbid:** stale/index-shifted patch targets wrong unit, model approves its own scope expansion, findings disappear, field freezing preserves a known incorrect dependent value, JSON validity substitutes for repair correctness.
- **Receipt:** R0 plus requested/applied/rejected paths, dependency reasons, base/new hashes, complete validation and paid-call count.

### ME-07 — Partial repair, repeated defect and delivery continuation
- **Parent / level:** T06/T07/T08; L1/L2/L3. Extend graph/content-repair/invalid-verification recovery and planned composer integration.
- **Fixture / oracle:** four quote defects, repair fixes three, next repeats the fourth; separate valid writer with malformed verifier report; valid RFP and accepted sibling section.
- **Fault / action:** exhaust only configured immutable correction allowance; trigger deterministic composition without another model writer.
- **Require:** last safe content survives, remaining defect stays visible, invalid report differs from proven candidate contradiction, file remains available with precise gaps and operational reason.
- **Forbid:** accept fourth defect, unbounded paid retries, fake accepted/enrichment-completed status, whole invalid candidate export, provider failure described as invalid RFP/insufficient source.
- **Receipt:** R0 plus defect trajectory, attempt/allowance ledger and artifact state/hash; temporary file does not close T06's substantive completion gate.

### ME-08 — Typed verification across every registered task
- **Parent / level:** T01/T02/T09/T19; L1/L2/LM. Registry-driven extension of `modelVerificationContext.test.ts`, `modelContract.test.ts` and task validators.
- **Fixture / oracle:** hold prose constant and mutate one decision-bearing typed field/path per table row below; compare full canonical payload/hash.
- **Fault / action:** run whole/batched verification, requirements-only pass and aggregate report; test old payload pins and new explicitly versioned formats.
- **Require:** type/path/ownership survive, batch quote scope stays restricted, aggregate coverage complete; `verify_grounding`/`repair_result` use full domain validation without recursive verifier loops.
- **Forbid:** omitted booleans/numbers/nulls, unchanged hash after meaningful mutation, cross-batch leakage, invented IDs, duplicate claims, silent in-flight repinning.
- **Receipt:** R0 plus registry census, per-task typed-path matrix, old/new wire hashes and scope receipts; no task omitted without explicit justified exemption.

| Registered task | Mandatory paired mutation / oracle |
| --- | --- |
| `analyze_chunk` | mandatory, null question, blocking level, separate volumes, new authority/modality |
| `classify_opportunity` | rating null/zero; critical_unknown; uncertain/out_of_scope; missing proof remains unknown |
| `summarize_review` | directive tied to actual review ID; advisory/finalization; suggestion is not buyer obligation |
| `plan_structure` | volume, proposed/buyer-fact decision, requirement ownership, section mode |
| `plan_blueprint` | structure fields plus target_words, unit ownership, secondary-link reason and decision links; planning length is not buyer mandate |
| `plan_proposal` | volume, requirement ownership and question severity with same prose |
| `draft_section` | table boundaries, fact/assumption ownership, undeclared company claim, required IDs and source provenance |
| `plan_commercial` | included_in_base; null/numeric quantity/rate/period; charge type; dependencies and requirement/section IDs; units |
| `review_proposal` | answered/partial/missing/NA-approved; blocking/advisory; output enum cannot create Owner approval |
| `inspect_source_page` | nullable buyer/deadline/link, page kind, exact permitted link IDs; no invented absent deadline |
| `verify_grounding` | claim/requirement statuses, candidate hash, IDs, severity and source spans; report cannot certify itself |
| `repair_result` | target task, base hash and allowed paths; inner result receives complete target-task validation |
| `connection_probe` | transport/config identity and ready schema only; no claim about business quality or another model's capacity |

### ME-09 — Correlated reviewers and omitted claims
- **Parent / level:** T01/T09/T16; L1/L2/LM. Extend graph/grounding/catalog tests; qualified live task/provider pairs later.
- **Fixture / oracle:** A writer invents certification; A verifier agrees; B detects it; only-A-available variant; two model IDs from same family; report echoes all IDs while omitting material table claim.
- **Fault / action:** route and aggregate reports, then score frozen independently labeled holdout through production prompts.
- **Require:** actual independence/family recorded, qualified independent route preferred where authorized, deterministic proof rule rejects invented claim even when reviewers agree; assurance limitation explicit when independence absent.
- **Forbid:** same-family labeled independent, majority vote replaces evidence, processed-ID echo hides omission, fallback shares data without permission.
- **Receipt:** R0 plus model/family pair, per-claim gold/verdict, omitted-claim count, agreement versus correctness, false acceptance/rejection and statistical limits.

### ME-10 — Provider taxonomy and correctly scoped cooldown
- **Parent / level:** T06/T10; L1/L2/L3. Extend model/round-robin/catalog/payload-diagnostic tests and localized UI mappings.
- **Fixture / oracle:** 403 model quota, true 401 bad key, 403 project permission, 429 Retry-After, 5xx, 400 schema error, terminal accepted credit exhaustion; model/account/project scope variants and unsafe echoed text.
- **Fault / action:** controlled HTTP and clock, two models sharing connection, another project, same account with account-wide exhaustion; run actual routing/SQL cooldown decisions.
- **Require:** reason and cooldown scope match evidence; honor eligible time; healthy sibling stays eligible for model-only quota; terminal polling stops while usage may remain unknown.
- **Forbid:** all 403→auth, disable shared connection for model-only quota, evade account quota through sibling, early retry, automatic billing/free-only change, unauthorized fallback or unsafe echo logs.
- **Receipt:** R0 plus normalized/raw-safe codes, scope and eligibility matrix, before/at/after clock tests and POST/GET counts; no invented cooldown constant.

### ME-11 — Request identity, truthful unknown usage and automatic recovery
- **Parent / level:** T06/T10/T12/T18; L2/L3. Extend runtime/round-robin/policy/payload tests, writer-handoff and alternate-writer integration with fully migrated functions.
- **Fixture / oracle:** POST accepted then connection lost; terminal failure no tokens; valid alternate candidate; candidate persisted before checkpoint crash; source/permission change before resume.
- **Fault / action:** rotate leases and replay cache/poll/retry/handoff; execute each table row below under automatic and manual route policies, including concurrent duplicate recovery.
- **Require:** remote ID and exact wire/prompt/schema/route/source identity preserved; valid automatic result may finish with null usage; deterministic delivery independent; permitted new operation has new explicit lineage and remaining allowance.
- **Forbid:** duplicate same accepted POST, unknown→zero, overwritten receipt, changed identity under old call key, permanent global hold from old terminal unknown, daily automatic token/call caps or billing attestation, exhausted allowance reset.
- **Receipt:** R0 plus phase prefix, remote-ID hash, lease sequence, immutable ledger/budget diffs, model-call counts and artifact side-effect proof; inspect final SQL wrappers for hidden blanket holds.

| Execution/receipt state | Required transition |
| --- | --- |
| Valid automatic candidate; usage null | Accept only if content/identity gates pass; retain null; no legacy manual `USAGE_UNKNOWN` block |
| Known active remote request before deadline | Poll known ID; no duplicate POST or new candidate allowance |
| Ambiguous same-target before policy boundary/deadline | Visible temporary wait; other-target behavior follows existing route/permission policy |
| Ambiguous after applicable boundary and remote deadline; no known active execution | Canonical recovery may admit fresh round with immutable old receipt/new lineage; no hidden budget reset |
| Terminal failed remote request; usage null; retained valid alternate | Reviewed no-duplicate handoff if provenance/remaining allowance allow; no impossible token reconciliation forever |
| Unrelated old terminal unknown | No workspace/global hold on independent authorized automatic work |
| Candidate correction exhausted | Artifact assembly continues; no additional writer allowance from accounting cleanup |
| Manual route | Preserve manual-policy constraints unless explicitly changed; automatic precedence does not erase them |

The existing policy-derived ambiguous-target boundary is 15 minutes subject to remote deadline and later wrappers;
verify the actual migrated predicate, then test immediately before/at/after it and the later deadline. It is not a new timeout introduced by this appendix.

### ME-12 — Historical pins and canonical recovery variants
- **Parent / level:** T10/T12/T15/T18; L1/L2/L3. Extend semantic/verification prompt/runtime/recheck/invalid-report recovery tests and `test_proposal_verifier_recheck.py`.
- **Fixture / oracle:** old in-flight format1/2; settled candidate0/old report; candidate1 after repair; revoked cached result; changed source; altered producer; crash after recheck seed; invalid corrective report; terminal unknown variants.
- **Fault / action:** invoke exact permitted recheck/successor/refusal for each; replay before/after lease change and authorization loss.
- **Require:** old payload unchanged, new reevaluation has explicit lineage/format, producer and candidate hashes exact, fresh authorization each replay, recheck writer allowance zero and only permitted verifier/report correction.
- **Forbid:** candidate1 slips through candidate0-only route, guard weakened to pass fixture, old report relabeled accepted, budget reset, provenance bypass, infinite report/writer recovery, cache return after revoke.
- **Receipt:** R0 plus parent/child and producer hashes, old/new request hashes, allowance/action trace and unchanged historical-row hashes; private production IDs never enter fixtures.

### ME-13 — Prompt injection and permissions through repair/fallback
- **Parent / level:** T12/T16/T19; L1/L2/L3/LM. Extend model policy/company-claims/recheck integration and routing/repair tests.
- **Fixture / oracle:** RFP text asks to ignore rules/approve/reveal credentials; review note asks to replace bank details; ordinary confidentiality clause control; source revoked between writer/verifier; unauthorized fallback provider.
- **Fault / action:** run each phase with candidate source instructions and changing manifests; inspect backend actions independently of model response.
- **Require:** source remains data, legitimate confidentiality requirement processable, every provider/source combination authorized, model tool-less, safe gaps omit blocked content.
- **Forbid:** source grants authority, tools/messages/submission/account changes/approval occur, data policy expands, secret leaks, or benign confidentiality keyword is automatically malicious.
- **Receipt:** R0 plus safe action/call trace, source/provider manifest hashes and permission verdicts; no claim that prompt text alone enforces security.

### ME-14 — Qualified model/prompt regression campaign
- **Parent / level:** T01/T09/T19 plus task-specific parents; L1/L2/LM. Extend existing live evaluation harness and canonical authority/verification validators.
- **Fixture / oracle:** synthetic development corpus and authorized private independently reviewed holdout; duplicate/translation/near-duplicate families kept in one split; every semantic class has faithful/defective controls plus partial/unrelated/empty inputs.
- **Fault / action:** resolve D07 before outcomes: freeze corpus, languages/tasks/models, held-out sample sizes, repeat policy, noncritical limits and critical gates, plus routing/config/prompt hashes; qualify enabled authorized targets with canonical validation before gold scoring.
- **Require:** preserve every first failure and retry, raw outputs privately when authorized, transport/refusal/quota/skipped separated from semantic outcomes, null usage retained, reproducible baseline and change explanation.
- **Forbid:** quota counted pass, dropped/duplicate predictions, split leakage, test-only prompt divergence, writer labels own truth, synthetic scores presented as actual business accuracy, unqualified new route promoted.
- **Receipt:** R0 plus attempted/completed/scored denominators; per-class false acceptance/rejection/omission, critical-clause preservation, unsupported claims, span validity, completeness, recovery and cost/usage; sampled rates include suitable confidence intervals.
- **Gate:** known critical integrity regression blocks promotion; unavailable task/model stays not evaluated. `backend/packages/evaluation` opportunity metrics require an explicit proposal evaluator, not a renamed score.

## 7. مواصفات الإدخال والتجميع والتصدير والاستعادة: 24 حالة

### IN-01 — Empty or whitespace-only input
- **Parent / level:** T03; L1/L2/L4/L5. Extend document-worker/flexible-input/eligibility tests; new intake-assessment/browser fallback.
- **Fixture / oracle:** zero-byte TXT/PDF, whitespace TXT, syntactically valid all-blank PDF; no other useful scope source.
- **Fault / action:** select/upload through real validation, record authenticated intake attempt and request canonical template without pretending zero bytes were accepted as a valid original.
- **Require:** persisted template, selected outline, all missing fields labeled/yellow, precise insufficient-information notice; enrichment not started, verified artifact available.
- **Forbid:** model call, invented buyer/scope/price/company data, fake extraction/original success, unrelated proposal invalidation or approval.
- **Receipt:** R0 plus original validation, reason and template lineage, gap/highlight coverage and independently downloaded hash.

### IN-02 — Corrupt, unsupported or password-protected input
- **Parent / level:** T03/T05; L1/L3/L4. Reuse original-validation HTTP fixture and add intake fallback cases.
- **Fixture / oracle:** truncated DOCX, wrong PDF signature, unsupported extension, encrypted PDF; useful-scope-present and absent variants.
- **Fault / action:** fail exact parser/validation boundary; select accurate corrupt/unsupported/password-needed reason and continue with other usable sources when present.
- **Require:** safe persisted template only when no usable scope; protected/recoverable source remains awaiting reading; otherwise grounded draft retains valid context.
- **Forbid:** unsafe archive expansion/active content, parser failure implies no buyer requirements, accepted bad bytes, all-blank result despite useful source, false business-invalid label.
- **Receipt:** R0 plus parser code/reason, source inclusion/exclusion map and artifact content/OOXML proof; zero unnecessary model calls.

### IN-03 — Valid image-only RFP with OCR success or outage
- **Parent / level:** T05; L1/L3/L4/L5. Real synthetic PDF image bytes; OCR adapter/harness is planned, not assumed available.
- **Fixture / oracle:** Arabic/English scanned requirements, dates and amounts with independently checked page text; low-confidence page, transient OCR failure and successful recovery variants.
- **Fault / action:** initial no-text-layer extraction, bounded OCR attempt/restart and later completion with original/page hashes and extraction version.
- **Require:** unreadable-pending-OCR state, preserved originals and page confidence, exact known obligations after success; provisional artifact may precede recovery but completion remains open.
- **Forbid:** scan→invalid, page markers treated as readable content, guessed numbers, final readiness with unread critical pages, provisional empty template counted as valid-RFP success.
- **Receipt:** R0 plus page coverage/confidence, oracle text/requirement diff and provisional/successor snapshot identities.

### IN-04 — Mixed readable, blank and unreadable pages
- **Parent / level:** T04/T12; L1/L2/L3/L5. Extend mixed-input flexible workflow fixtures to page-level preservation.
- **Fixture / oracle:** readable pages 1/2/4, scanned page3, plus harmless blank separator; independent obligation on each nonblank page.
- **Fault / action:** fail only page3 extraction, compose/read available pages, then deliver OCR result into a successor snapshot.
- **Require:** readable content and source refs retained, separator identified as blank, missing page explicit, known-scope draft available, old paid input/history unchanged.
- **Forbid:** one bad/blank page discards whole RFP, full-coverage claim before recovery, unknown→zero, omitted mandatory section, retroactive source-hash mutation.
- **Receipt:** R0 plus covered/blank/unread map, requirement conservation, source/extraction hashes and successor lineage.

### IN-05 — Reference-only material versus a valid buyer brief
- **Parent / level:** T03/T01; L1/L2/L3. Reuse flexible runtime reference/notice fixtures.
- **Fixture / oracle:** Buyer A case study alone, then same study with valid Buyer B brief; source authority independently labeled.
- **Fault / action:** run intake and draft composition with reference classification and empty/nonempty buyer requirement set.
- **Require:** reference-only limitations honest; sufficient Buyer B brief produces source-grounded response; Buyer A content stays attributed reference, never buyer mandate.
- **Forbid:** copied buyer identity/prices/certification/mandatory clauses, non-RFP called corrupt, blank template while valid scope exists.
- **Receipt:** R0 plus authority tuple, required/forbidden claim oracle and actual file/source manifest.

### IN-06 — Valid input at processing-capacity boundaries
- **Parent / level:** T05/T14; L1/L3. Extend small/medium/large package fixtures with generated boundary inputs.
- **Fixture / oracle:** just-under/at/over configured byte/page/context limit, safe long-table DOCX expansion; complete independent content inventory.
- **Fault / action:** trigger segmenter/parser capacity guard and supported segmented/streamed recovery; distinguish safe archive security cap from business validity.
- **Require:** preserve all admitted known content, explicit coverage/overflow state, accurate capacity notice; unsupported case remains completion-open rather than silently accepted.
- **Forbid:** truncation, security expansion limits raised to pass, capacity→invalid RFP, blank-template success or lost original lineage.
- **Receipt:** R0 plus configured limits, segments/covered units, omitted ranges and recovery/admission outcome.

### AR-01 — Atomic early snapshot without self-invalidating generation
- **Parent / level:** T01/T07/T11; L2 PostgreSQL/L3. Reuse workflow/database atomic command fixture; new delivery-snapshot integration.
- **Fixture / oracle:** valid RFP and approved outline; original active/base version recorded; provider transport blocked before first reservation.
- **Fault / action:** crash before commit and after commit-before-response; replay command; continue generation after early snapshot publication.
- **Require:** either no accepted operation or complete durable snapshot/render job; replay same identity, renderable grounded draft with gaps, generation base guard still valid.
- **Forbid:** paid reservation before minimum delivery persistence, duplicate active snapshot/ordinal, orphan audit/rows, altered prior approval, fake model success or snapshot invalidating its own plan.
- **Receipt:** R0 plus transaction/replay IDs, row counts, base/active-version invariants and zero provider POSTs before durable snapshot.

### AR-02 — Every model unavailable at every stage
- **Parent / level:** T06/T07; L2/L3/L4. User-resolved D06 and BC-01 govern this case; optional manual authoring is separate.
- **Fixture / oracle:** valid RFP and exact accepted history; configuration, quota, timeout, transport and unknown-accounting failures at analysis/planning/drafting/commercial/review/reconciliation.
- **Fault / action:** remove or reject every eligible model route; inject known terminal errors early and a late provider/file callback. Exercise queue wait and worker restart.
- **Require:** immediate clear `AI_AGENTS_UNAVAILABLE` once no agent is available; any earlier terminal error returns when known. One immutable 600-second deadline includes queueing, all model stages and complete required files. Preserve accepted content, existing ready drafts and unknown usage without claiming successful issuance.
- **Forbid:** wait until the deadline to reveal known unavailability, require a human fallback, reset the deadline per stage, treat a valid RFP as invalid, promote a bad candidate, count a template/source copy as a complete response, erase usage or duplicate ambiguous paid requests.
- **Receipt:** R0 plus accepted/deadline/error timestamps, per-stage content and ledger conservation, callback disposition and actual full-package or terminal-error identity. Optional manual completion has its own evidence and is not automatic-request success.

### AR-03 — Reject one unit without erasing accepted siblings
- **Parent / level:** T01/T02/T04/T07; L1/L2/L3. Extend generation-content/evidence/export-draft tests.
- **Fixture / oracle:** three accepted sections, one quote/authority-defective candidate, confirmed commercial inputs and unresolved prices; repeat with historical accepted units pinned to older schema/prompt/verifier assurance.
- **Fault / action:** exhaust fourth-unit repair, assemble accepted content plus precise gap or validated deterministic response; rescue historical units without changing their recorded acceptance provenance.
- **Require:** accepted hashes/known values unchanged, unresolved totals withheld, exact gap count and requirement accounting; historical assurance explicitly labeled legacy/unresolved unless a separately recorded successor revalidation passes the new rules.
- **Forbid:** rewrite accepted facts, export rejected text as assumption, zero-fill missing price, drop requirement, mark enrichment complete, or source freshness alone promotes an old unit to new semantic assurance.
- **Receipt:** R0 plus per-unit before/after hashes, original source/prompt/schema/verifier pins, producer/acceptance provenance, successor revalidation or visible legacy status, and independent coverage.

### AR-04 — Source change or revocation at each delivery boundary
- **Parent / level:** T12; L2 PostgreSQL/L3. Extend flexible-input freshness/database revocation/export acceptance tests.
- **Fixture / oracle:** used source text changes, unused attachment added, source permission revoked, membership revoked; separate variants at snapshot/render/upload/complete/download.
- **Fault / action:** race the change against phase transition; attempt cached replay and direct authenticated artifact access.
- **Require:** new used content creates successor/invalidate-final; unused input does not rebase old paid context; permitted historical draft labeled accurately; revoked protected delivery denied.
- **Forbid:** leak revoked bytes, bypass RLS, mutate old hash/snapshot, blanket invalidation for unrelated content, stale final approval; sanitized template cannot include revoked content.
- **Receipt:** R0 plus permission checks at each phase, changed-source scope, allowed/denied hashes and absence of forbidden content in returned bytes.

### AR-05 — Human edits race with enrichment and publication
- **Parent / level:** T15/T20; L2 PostgreSQL/L3/L4. Extend proposal-review evidence/UI and flexible late-review fixtures.
- **Fixture / oracle:** saved answer/section edit versus model completion, two publishers against same base, unsaved input and changed source signature.
- **Fault / action:** coordinate simultaneous transactions and stale expected revisions; reload editor and request old/new draft downloads.
- **Require:** compare-and-swap prevents overwrites; explicit conflict/new revision; old snapshot remains immutable with revision label; feedback counted applied only after actual incorporation.
- **Forbid:** lost human answer, unsaved feedback silently included, duplicate active ordinal/publication, feedback-saved reported as feedback-applied, title-only merge.
- **Receipt:** R0 plus ordered revisions/audit, winning write, old/new content hashes and UI/download assertions.

### EX-01 — Crash and restart at every artifact boundary
- **Parent / level:** T07/T11/T17; L2/L3. Reuse lease/replay and reserve/complete paths; new isolated render-worker fault harness.
- **Fixture / oracle:** combined draft with fixed render metadata; parameterize B0–B9 below; exact authorized content and expected logical object count.
- **Fault / action:** hard-kill worker or drop response at each boundary; expire/reclaim lease, resume from durable phase, redeliver same operation.
- **Require:** atomic outbox/job handoff, hash-check existing object, verified content+bytes before ready, one logical artifact/volume, finite configured retries and current permission.
- **Forbid:** stale-lease completion, duplicate active reservation/object, double capacity release, ready on partial bytes, added model call or lost accepted content.
- **Receipt:** R0 per boundary plus process/lease sequence, attempts, object inventory and logical completion count; renderer metadata determinism or declared byte variance documented.

| Boundary | Inject immediately after / before |
| --- | --- |
| B0 | snapshot commit before job handoff/enqueue completion |
| B1 | claim before rendering |
| B2 | render before durable byte staging |
| B3 | artifact reservation before upload |
| B4 | partial upload before object commit |
| B5 | committed object before upload response |
| B6 | uploaded object before verification |
| B7 | verification before completion transaction |
| B8 | completion commit before response |
| B9 | ready state before browser download |

### EX-02 — Browser closure, missing fonts and render timeout
- **Parent / level:** T11; L3/L4/L5. Reuse browser observer/renderer helpers; new server-job/reconnect tests.
- **Fixture / oracle:** accepted draft; close tab, deny browser fonts/Worker, stop primary server renderer at configured attempt timeout, enable proven fallback renderer.
- **Fault / action:** reopen session, observe durable job, execute bounded retry/fallback and download authorized final bytes.
- **Require:** tab-independent progress, server bundled fonts, same canonical content/gaps across fallback, persistent result; if every renderer fails report delivery incident and retain snapshot.
- **Forbid:** local unchecked bytes reported server-verified, lost table/RTL/source text, AI re-generation for packaging, indefinite success spinner, outage called invalid RFP.
- **Receipt:** R0 plus reconnect trace, renderer/fallback cause and every-page visual evidence; full renderer failure cannot count as delivery pass.

### EX-03 — Storage interruption, corruption and expired authorization
- **Parent / level:** T11/T12; L2/L3/L4. Extend `proposalExportAcceptance.test.ts`, HTTP Storage adapter and export-draft tests.
- **Fixture / oracle:** 503 before/after upload, 409 same/different bytes, truncated object, corrupted download and expired prepare/complete/download authority.
- **Fault / action:** retry/resume, inspect existing bytes, renew only under current authority, perform independent backend and browser downloads.
- **Require:** reuse identical verified object; mismatch stays not-ready; expiry renewal preserves immutable content and actual role/approval; browser bytes equal independent download.
- **Forbid:** every 409 blindly accepted, forged ready/hash, new model call, automatic final approval renewal, unauthenticated fallback stream.
- **Receipt:** R0 plus expected/actual hash/size, renewal/retry trace, denied-authority tests and observed identical-byte comparison.

### EX-04 — Fresh transport UUIDs cannot multiply logical exports
- **Parent / level:** T14; L2 PostgreSQL/L3. Extend command replay/storage-reservation tests; new logical-export dedupe fixture.
- **Fixture / oracle:** same snapshot sent 100 sequential/20 concurrent times with same or fresh transport UUID; changed body/same UUID; near existing export/storage capacity.
- **Fault / action:** submit requests concurrently, retry after dropped reply, then request genuinely different snapshot/tenant/mode/volume sets.
- **Require:** same logical export reuses one operation and ready artifact, capacity reserved once, conflicting UUID/body rejected, different authorized contents remain distinct.
- **Forbid:** repeated downloads consume fresh render allocations, duplicate objects/reservations, dedupe across tenants/authority, arbitrary cap removal or new daily AI policy.
- **Receipt:** R0 plus logical/transport keys, row/object/reserved-byte deltas, conflict/admission outcomes; 100/20 are test stress sizes, not new product limits.

### EX-05 — Two-volume package commits as one logical delivery
- **Parent / level:** T20; L1/L2/L3/L4/L5. Extend separated export-draft/structure/acceptance fixtures; new manifest commit tests.
- **Fixture / oracle:** RFP requires technical+financial; technical succeeds, financial fails at each B boundary; source/user edit between volume attempts.
- **Fault / action:** retry only missing volume, verify both against same immutable snapshot, publish package manifest and exercise UI download completion.
- **Require:** partial/preparing until required volume set verified; individual preview clearly partial; complete package has both hashes and same snapshot; no pricing in technical part.
- **Forbid:** mixed revisions, success toast after one file, duplicate pricing or global pricing question leak, extra model call, deleting verified reusable sibling as fake rollback.
- **Receipt:** R0 plus manifest hash/expected/actual volume set, per-volume snapshot/hash and actual browser completion evidence.

### EX-06 — Typed yellow gaps, Word integrity and visual quality
- **Parent / level:** T02/T13; L1/L3/L5. Extend actual renderer/export-model fixtures and verifier; formatting/gap validator is new.
- **Fixture / oracle:** Arabic/English/mixed inline gap, missing section, null quantity/rate/currency, known zero, long labels/table; independent gap-ID map.
- **Fault / action:** render, then remove yellow, color wrong run, drop gap, insert false value, corrupt ZIP, add external relationship/tracked change; render all valid pages.
- **Require:** every gap has localized visible label and `w:highlight w:val="yellow"`, confirmed neighboring text preserved, known zero distinct from unknown, RTL/fonts/tables/TOC and update fields valid.
- **Forbid:** marker regex alone certifies gaps, missing→zero, hidden/clipped labels, unsafe/missing-highlight artifact accepted, XML/font embedding substitutes for every-page QA.
- **Receipt:** R0 plus gap→OOXML-run coverage, mutation rejection, DOCX/PDF/page hashes and recorded visual result for every page.

### OP-01 — Unknown paid usage and deterministic assembly remain independent
- **Parent / level:** T10/T06; L2/L3. Reuse usage/recovery fixtures and planned delivery test.
- **Fixture / oracle:** known terminal unknown-token request, safe alternate/fragment available; active/ambiguous request control; exhausted correction control.
- **Fault / action:** attempt model recovery under ME-11 policy and independently assemble/export authorized safe content with no model client.
- **Require:** unknown stays null, execution state classified accurately, permitted automatic recovery proceeds when eligible, artifact available independently of accounting settlement.
- **Forbid:** permanent global unknown hold, unknown→zero, hidden POST/allowance reset, invalid candidate acceptance, draft delivery changing billing or approval.
- **Receipt:** R0 plus exact ledger/budget diff, eligibility reason and zero provider-call side effect from assembly.

### OP-02 — Capacity exhaustion and safe cleanup
- **Parent / level:** T14/T17; L2/L3. Extend `operations.test.ts` abandoned upload/active-reference/cleanup lease cases.
- **Fixture / oracle:** existing database/storage/render capacity near full before admission and after unrelated growth; orphan reservation; deletion failure; erroneous cleanup targeting active artifact.
- **Fault / action:** admit/reserve, run enrichment/render, retry cleanup under lease, request existing authorized ready artifact.
- **Require:** minimum delivery capacity accounted for, accurate capacity state, existing file reusable, reclaim only after verified deletion, active source/snapshot/artifact protected.
- **Forbid:** delete accepted draft, release reservation before deletion, stale-lease cleanup, reset quota to pass, mislabel input invalid or hide post-admission SLO breach.
- **Receipt:** R0 plus inventory/reserved-byte ledger, admission decision, cleanup/audit history and incident/recovery timings; limits measured via D04.

### OP-03 — Approval becomes stale during artifact delivery
- **Parent / level:** T15/T20; L2 PostgreSQL/L3/L4. Extend commercial approval and export freshness/role tests.
- **Fixture / oracle:** approved current version; mutate rate/answer/coverage/company verification/evidence/active version; Reviewer/Editor/Owner/revoked-Owner matrix.
- **Fault / action:** race each mutation against render/upload/complete/download and package endpoints; separately request permitted draft.
- **Require:** final binding rechecked and rejected if stale; only currently authorized draft available with real draft state; audit/hash bindings preserved.
- **Forbid:** successful render grants approval, client role authorizes server, final relabeled only by filename, stale package bypass, disclosure after revocation.
- **Receipt:** R0 plus approval-binding diff, role/endpoint matrix, final denial and actual permitted-draft bytes.

### OP-04 — Restore original files and the delivery graph
- **Parent / level:** T18; L2/L3/L4. Extend `recovery.test.ts`; reuse `production-schema/test_schema_restore.mjs` only for catalog/role integrity.
- **Fixture / oracle:** ready draft, partial two-volume package, active render lease, unknown usage, historical approval, typed gaps and original bytes; corrupt row/object hash or omit financial file.
- **Fault / action:** crash restore before commit and resume into clean isolated deployment; verify manifest/relationships then explicitly activate authorized test identity/execution.
- **Require:** corrupt/incomplete restore cannot complete; stale leases reconciled, approvals/processing disabled per restore contract, exact ready bytes recover, only missing valid volume resumes, unknown usage preserved.
- **Forbid:** restore sessions/secrets, reactivate old approvals automatically, replay ambiguous paid work, duplicate/orphan artifacts, package-ready without files, revive revoked permission.
- **Receipt:** R0 plus backup/restore manifests, FK/ACL/object checks, activation audit, byte equality and zero unintended provider calls; record measured RPO/RTO via D05.

### UX-01 — File availability and enrichment progress are separate
- **Parent / level:** T03/T06/T11; L4/L5. Extend PendingProposal tests only with implemented persisted contract and actual Playwright flow.
- **Fixture / oracle:** empty-input template, valid draft while AI retries, partially enriched draft and complete reviewed draft; reload and pending deep link.
- **Fault / action:** disconnect/reconnect UI, request each persisted revision, fail one package volume, inspect localized status and keyboard access.
- **Require:** download action for available snapshot, exact revision/gap count, correct input versus service cause, separate enrichment state, success only after actual full logical download.
- **Forbid:** template called complete/correct/approved, valid-input blank template accepted, available file hidden behind spinner, secrets/customer text in telemetry.
- **Receipt:** R0 plus DOM/accessibility assertions, screenshots, source/version identity and actual downloaded file/package hashes.

### UX-02 — Preserve strict acceptance of a real completed proposal
- **Parent / level:** T01/T13/T15; L4/L5. Reuse existing actual export workflow, Python/JS harness, selection SQL and selection/acceptance tests unchanged in intent.
- **Fixture / oracle:** explicitly selected genuine current completed proposal and expected immutable runtime image; no synthetic production rows or fault injection.
- **Fault / action:** obtain genuine allowlisted session, click editor download, independently download server artifact, compare bytes and review content/pages.
- **Require:** exact current plan/version/revision, authenticated authority, known artifact identities, matching hash/size and approved volume rules; no generation/approval mutation.
- **Forbid:** loosen completed-plan selector to pass partial case, automatic HTTP fallback after browser failure, fabricated artifact or raw customer content in logs/Actions.
- **Receipt:** existing encrypted private report plus manifest/gap/visual evidence; safe public result identifies coverage limits without private IDs/text.

### UX-03 — Separate acceptance contract for early/partial delivery
- **Parent / level:** T01/T03/T13; L2/L4/L5. New proposed `delivery-artifact-selection.sql`, `delivery-artifact-acceptance.mjs/.py` and acceptance workflow.
- **Fixture / oracle:** selected persisted snapshot with running/blocked AI plan and separate invalid-input template; isolated stack first, authorized real production records later.
- **Fault / action:** validate exact snapshot/revision/hash, current source permission and expected volume set; click persistent download and compare independent bytes.
- **Require:** distinct readiness oracles for template versus valid grounded draft, genuine session, scoped write allowlist, private transfer/cleanup, same authorized content independently verified.
- **Forbid:** unrestricted selection, bypassed membership/freshness, false completed-model state, old selector weakened, empty template passes valid-input test.
- **Receipt:** R0 plus new acceptance contract version, selection SHA, permission receipt, package hashes and every-page QA; build on existing safe harness helpers.

## 8. تغطية إضافية لازمة لإغلاق الفجوات

هذه الحالات تكمل التفاصيل الثمانية والثلاثين السابقة؛ لا تستبدل أي حالة منها.

### RT-01 — Retrieval recall, company-proof absence and authorization
- **Parent / level:** T01/T02/T16; L1/L2/LM. Extend generation-evidence/company-claims fixtures; new requirement-level retrieval oracle.
- **Fixture / oracle:** only supporting evidence is source7, after character2000, cross-language synonym, equal-rank tie; expired/unverified/revoked lookalike and unrelated style sample controls.
- **Fault / action:** apply context-cap selection/retrieval, then repeat with required source withheld by permission and with a genuinely absent capability record.
- **Require:** relevant authorized evidence retrieved or explicit measurable retrieval gap; current verified support separate from source absence; targeted retrieval preserves full needed context.
- **Forbid:** “not retrieved” becomes company lacks capability, lexical ranking asserts authority, context truncation hides qualifier, unauthorized source included or external vector platform assumed necessary.
- **Receipt:** R0 plus source/requirement gold set, recall/precision/omission by language/rank, selected/excluded reason and downstream claim verdict.

### RT-02 — Cross-section obligations and annex precedence
- **Parent / level:** T01/T09/T16/T20; L1/L2/LM. Extend planning/blueprint/grounding/commercial fixtures and corpus.
- **Fixture / oracle:** condition in next chunk/table footnote, annex changes date/quantity, superseded clause, same number with different unit, contradictory scope/price/delivery across sections.
- **Fault / action:** segment source, map requirements to responses, mutate one relation/precedence and run whole-proposal reconciliation with typed context.
- **Require:** correct governing clause and linked qualifier retained; all obligations accounted for AND substantively answered/gapped separately; Decimal calculations match confirmed inputs.
- **Forbid:** processed-block IDs prove requirement completeness, long prose or generic question proves adequate response, stale annex wins, model invents binding totals/NA approval, duplicate/drop at split boundary.
- **Receipt:** R0 plus source→requirement→response matrix, governing-version oracle, cross-section contradictions and deterministic calculation outputs.

### OP-05 — Local delivery fairness and noncritical maintenance isolation
- **Parent / level:** T07/T17/T18; L2 PostgreSQL/L3. Extend continuous-model/queue/operations fixtures and worker integration.
- **Fixture / oracle:** all model slots occupied, active background polls, older/newer owners, due local render; inject maintenance/cleanup/notification failure independently from authorization/storage-capacity failure.
- **Fault / action:** schedule mixed load with frozen clock; restart worker and run many dispatches using actual queue selection, then restore saved queue state.
- **Require:** local render progresses independently of model admission under measured fair policy; noncritical fault logged/recovered; critical authority/capacity guards still enforced; no class/owner starved.
- **Forbid:** swallow maintenance error as success, maintenance blocks all dispatch, poll consumes model admission unfairly, delivery bypasses source permission, arbitrary latency/SLO asserted without load evidence.
- **Receipt:** R0 plus admission/claim timeline per class/owner, queue age/latency distribution, fault recovery trace and denominators including all failures.

### BC-01 — Early no-agent error and 600-second issuance deadline
- **Owner decision:** November 4 supersedes the prior mandatory human-completion requirement. Optional manual editing is a separate action.
- **Parent / level:** T06/T07/T17/T18; L1/L2 PostgreSQL/L3/L4.
- **Fixture / oracle:** valid RFP; all eligible providers unavailable, one healthy alternative, terminal validation/storage/source failure, long queue wait, accepted remote request with unknown usage, partial multi-volume artifact.
- **Fault / action:** freeze acceptance time; exercise before, exactly at and after 600 seconds through actual admission, phase transitions, repair and rendering. Restart workers and deliver a late provider/file callback. Inject an unrecoverable error well before the deadline.
- **Require:** no eligible agent returns a clear immediate unavailable error; earlier terminal failures are returned when known. One 600-second request deadline includes queue wait and every stage. Complete authorized artifacts alone count as issuance. Preserve accepted history and unknown usage; no new model reservation or final success after expiry.
- **Forbid:** reset the deadline per stage, wait until ten minutes to reveal a known failure, require a human fallback, call a valid RFP invalid, claim a template/partial package is successful issuance, erase unknown accounting or duplicate an ambiguous paid request.
- **Receipt:** R0 plus accepted/deadline/known-failure/terminal timestamps, actual reservation/job transition traces, exact output hashes when successful, retry/restart/late-result assertions and visible client error. The decision is resolved; implementation and hosted proof remain required.

## 9. أوامر الاختبارات الموجودة وخطة تشغيل الجديد

الأوامر التالية تشغل **ملفات موجودة** فقط. لا تستدعي مزودًا حيًا ولا تثبت الحالات المقترحة قبل إضافتها.
من جذر المستودع، تُنفذ كل مجموعة من مجلدها الموضح؛ لا تستخدم `npm test -- <file>` في backend لتضييق النطاق.

```sh
npm ci --prefix backend
npm ci --prefix frontend
```

من `backend/`، مجموعات رجوع مركزة يمكن تشغيلها الآن:

```sh
npx vitest run tests/backend/modelAnalysisVerification.test.ts tests/backend/modelGrounding.test.ts tests/backend/modelStructuralReferences.test.ts tests/backend/modelCompanyClaims.test.ts
npx vitest run tests/backend/modelValidationDiagnostics.test.ts tests/backend/modelContentRepair.test.ts tests/backend/modelGraph.test.ts tests/backend/modelVerificationContext.test.ts tests/backend/modelContract.test.ts
npx vitest run tests/backend/roundRobin.test.ts tests/backend/modelRuntime.test.ts tests/backend/modelPolicy.test.ts tests/backend/modelPayloadDiagnostics.test.ts
npx vitest run tests/backend/modelWriterValidationHandoff.integration.test.ts tests/backend/modelAlternateWriterRecovery.integration.test.ts tests/backend/modelVerifierRecheck.integration.test.ts tests/backend/modelInvalidVerificationRecovery.integration.test.ts
npx vitest run tests/backend/flexibleProposalInputs.test.ts tests/backend/flexibleInputDraftRuntime.test.ts tests/backend/generationEvidence.test.ts tests/backend/proposalPackages.test.ts
npx vitest run tests/backend/exportDraft.test.ts tests/backend/proposalExportStructure.test.ts tests/backend/proposalExportAcceptance.test.ts tests/backend/proposalExportSelection.integration.test.ts
npx vitest run tests/backend/database.test.ts tests/backend/httpDatabase.integration.test.ts tests/backend/commercial.test.ts tests/backend/operations.test.ts tests/backend/recovery.test.ts tests/backend/continuousModel.test.ts
```

من `frontend/`:

```sh
npx vitest run src/lib/documentWorker.test.ts src/test/exportRenderer.test.ts src/components/PendingProposal.test.tsx src/test/proposal-review.test.ts
```

من جذر المستودع، فحوص أدوات القبول الموجودة ثم الفحوص الكاملة المطلوبة قبل التسليم البرمجي:

```sh
python3 -m unittest discover -s backend/scripts/ops -p 'test_proposal_export_acceptance.py'
python3 -m unittest discover -s backend/scripts/ops -p 'test_proposal_verifier_recheck.py'
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix backend run build
npm --prefix frontend run typecheck
npm --prefix frontend test
npm --prefix frontend run build
```

الاختبارات الجديدة التالية **ليست موجودة بهذا العقد ولا يُقدم أمرها كأمر جاهز**:

| مجموعة مقترحة | ما يجب إضافته قبل تشغيلها | الإغلاق المرتبط |
| --- | --- | --- |
| intake/page/OCR | fixtures أصلية اصطناعية، adapter مصرح، oracle صفحات وتقييم إدخال | IN-01–06 |
| source-span/authority/patch | عقود ذات إصدار، resolver/collector/patch-validator حقيقية ومراجع مستقلة | ME-01–08 |
| delivery snapshot/concurrency | schema وأوامر وPostgreSQL race harness وتحويل تقدم إلى نسخ | AR-01–05 |
| durable artifact recovery | server renderer، fault proxy/process controls، object-store manifest assertions | EX-01–06 |
| delivery capacity/restore/fairness | جداول جديدة ضمن backup/retention، حمل معزول وإحصاءات دقيقة | OP-01–05 |
| early-draft acceptance | selector مستقل، genuine session، browser/download equality وprivate cleanup | UX-03 |
| semantic qualification | corpus مجمد، split integrity، canonical prompts، evaluator خاص بالعروض | ME-09/14، RT-01/02 |
| no-agent failure and issuance deadline | خطأ مبكر مثبت، مهلة شاملة 600 ثانية، حفظ التاريخ ومنع نجاح الملفات المتأخر؛ التحرير اليدوي اختياري | BC-01 |

كل PR يضيف أوامر هذه المجموعة بأسمائها الحقيقية إلى سجل التنفيذ. أداة catalog restore تحتاج مدخل catalog خاصًا؛
لا يطبع أو يُثبت مساره أو محتواه هنا. أدوات live-model/actual-export لا تشغّل تلقائيًا كجزء من قراءة الوثيقة؛
تحتاج تحديد البيئة والهوية والمدخلات وإصداراتها وحدود التجربة وفق التفويض القائم، دون إعادة طلب موافقة غير لازمة.

## 10. تسلسل القبول ومنع النجاح الشكلي

1. **قبل التنفيذ:** ثبّت W00، F/W/T/detail map، العقود المقترحة، مصادر الحقيقة وأسباب القيود D01–D07؛ لا تفترض حالة إنتاج من دليل تاريخي.
2. **الكود المحلي:** تُظهر حالة العيب فشل النسخة السابقة حيث يمكن، ثم نجاح الإصلاح والممنوعات؛ اجمع L1/L2 مع حماية العقود التاريخية.
3. **التزامن والأعطال:** نفذ L3 وPostgreSQL races وB0–B9؛ كل عطل له إيصال منفصل، ولا يترك نجاح الاستعادة خلفه محاسبة أو صلاحية خاطئة.
4. **التقييم الدلالي:** غط كل task ومسار مؤهل ولغة؛ corpus لا يتغير بعد رؤية النتيجة؛ غياب مزود يبقى غير مقيم، ولا يختفي من المقام.
5. **الملف:** L4/L5 يثبت تنزيلًا فعليًا مطابقًا وقراءة كل صفحة وجميع الأجزاء؛ gap count وyellow coverage ومحتوى جوهري حقائق مستقلة.
6. **دون نماذج:** يثبت BC-01 خطأ عدم الإتاحة فورًا، وحفظ العمل المقبول، وعدم تجاوز 600 ثانية أو إظهار قالب مؤقت بوصفه إصدارًا مكتملًا. لا يُشترط محرر بديل؛ التحرير اليدوي مسار اختياري مستقل وفق D06.
7. **النشر والتراجع:** اختبر صور/ترحيلات وعقود متوافقة وطلبًا قديمًا جاريًا؛ تراجع تجريبي يحفظ الملفات والإيصالات والتاريخ ويمنع إعادة الطلبات الملتبسة.
8. **القبول المتصل:** أعد MAIN-01–14 وE2E-01–10 المنطبقة حسب الخطط القائمة؛ E2E النهائي يحتاج حقائق وأسعارًا واعتمادًا حقيقيًا، فلا يُصطنع لإغلاقه.
9. **القرار:** كل assertion حرج في العينات يجب أن ينجح؛ ذلك لا يعني دقة عالمية 100%. تنشر الأعداد وفئات الإخفاق وفواصل الثقة وحدود الدليل.
10. **التتبع:** كل F وبند فرعي يحتاج code PR → receipt → deployment → hosted acceptance؛ الحالة `not_run` لا تصبح passed، وإعادة فشل تفتح الفجوة.

كانت الحالة عند إنشاء الملحق توثيقًا فقط. تُحدَّث حالات التنفيذ والاختبار والنشر والقبول بأدلتها المنفصلة في سجل التنفيذ؛ تبقى أي حالة غير مثبتة مفتوحة، ولا يحولها عدد اختبارات خط الأساس إلى نجاح.
