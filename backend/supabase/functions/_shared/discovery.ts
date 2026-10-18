/** Conservative, versioned scope screening. Ambiguous or mixed notices go to the model. */
export const SOFTWARE_SCOPE =
  "Software development, applications, digital transformation, AI, AI transformation, data engineering, systems integration, software licensing and software cybersecurity services across all sectors. Hardware procurement, installation and maintenance and unrelated physical works/services are outside scope. Mixed procurements require review of whether the software lot can be bid separately; never assume hardware delivery capability. An industry or buyer name alone does not establish the purchased scope.";

const software =
  /\b(software|applications?|erp|crm|saas|artificial intelligence|machine learning|digital transformation|data engineering|cybersecurity|cyber security|programming|web development|mobile apps?|api integration)\b|برمج|برامج|تطبيق|تحول.{0,12}(رقمي|الرقمي)|ذكاء.{0,12}(اصطناعي|الاصطناعي)|تعلم.{0,12}آلي|هندسة البيانات|تكامل.{0,12}(أنظمة|الأنظمة)|[اأ]من.{0,12}(معلومات|المعلومات|رقمي|الرقمي|سيبراني|السيبراني)/iu;
const physical: Array<[string, RegExp]> = [
  [
    "hardware",
    /\b(hardware|laptops?|computers?|lcd|monitors?|printers?|cameras?|usb|cables?)\b|أجهزة حاسوب|اجهزة حاسوب|شاشات|كاميرات|كوابل|إنارة الشوارع|انارة الشوارع|أجهزة داعمة للانترنت/iu,
  ],
  [
    "physical works",
    /\b(construction|civil works|solar systems|vehicle chargers|building renovation)\b|تنفيذ مبنى|إنشاء.{0,25}(مبنى|أنظمة الطاقة الشمسية)|صيانة المدارس|تأهيل.{0,25}(مبنى|أرضية)|حفر بئر|تطوير ميدان|توسعة.{0,25}قسم|توسعه.{0,25}قسم|مشروع مركز.{0,20}(انطلاق|إنطلاق|الإنطلاق|الانطلاق)|تنظيف حجر/iu,
  ],
  [
    "physical supplies",
    /\b(medical equipment|laboratory equipment|drinking water|furniture|timber)\b|مواد كيميائية|مستلزمات مخبرية|أجهزة.{0,15}مخبرية|توريد اشجار|توريد أشجار|توريد اخشاب|توريد أخشاب|شوادر|طاولات|لوازم.{0,20}عيادات|مستهلكات.{0,25}عيادات|عبوات مياه|الهدية السنوية|جهاز قياس القوة/iu,
  ],
];

export function screenSoftwareScope(text: string, scope: string | undefined) {
  if (scope !== "software_services" || software.test(text)) return null;
  // A platform/system/data centre can be software, hardware or mixed. Do not guess.
  if (
    /\b(platform|system|data cent(?:re|er))\b|مركز البيانات|نظام|منصة/iu.test(
      text,
    ) &&
    !/solar systems|أنظمة الطاقة الشمسية/iu.test(text)
  )
    return null;
  for (const [category, pattern] of physical) {
    const match = pattern.exec(text);
    if (match)
      return {
        status: "out_of_scope" as const,
        reason: `The published scope explicitly concerns ${category}, outside the configured software services scope. No software deliverable is stated.`,
        quote: match[0],
        method: "scope-rule-v1",
      };
  }
  return null;
}
