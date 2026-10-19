import nodemailer from "nodemailer";
import type { Backend, BackendEnvironment } from "./backend.ts";

function senderAddress(value: string | undefined): string | null {
  if (!value || /[\r\n]/.test(value)) return null;
  const parts = /^(?:[^<>]*<([^<>]+)>|([^<>]+))$/.exec(value.trim());
  const address = (parts?.[1] || parts?.[2] || "").trim();
  return /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(address)
    ? address
    : null;
}

export function smtpStatus(env: BackendEnvironment) {
  const s = env.smtp;
  const issues: string[] = [];
  if (!s || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s.host))
    issues.push("APP_SMTP_HOST");
  if (!s || ![465, 587, 2465, 2587].includes(s.port))
    issues.push("APP_SMTP_PORT");
  if (!s?.user) issues.push("APP_SMTP_USER");
  if (!s?.password) issues.push("APP_SMTP_PASSWORD");
  if (!senderAddress(s?.from)) issues.push("APP_SMTP_FROM");
  if (!s || !/^https:\/\//.test(s.publicUrl)) issues.push("APP_PUBLIC_URL");
  return {
    configured: issues.length === 0,
    issues,
    protocol: "SMTP",
    encryption: s?.port === 465 || s?.port === 2465 ? "TLS" : "STARTTLS",
  };
}

type Delivery = {
  id: string;
  lease_token: string;
  recipient: string;
  language: "ar" | "en";
  kind: "processing_failure" | "review_digest" | "test";
  payload: {
    discoveries?: number;
    proposals?: number;
    title?: string;
    detail?: string;
    entity_id?: string;
  };
};
export function notificationMessage(d: Delivery, env: BackendEnvironment) {
  const smtp = env.smtp!;
  const base = new URL(smtp.publicUrl);
  if (base.protocol !== "https:" || base.username || base.password)
    throw new Error("SMTP_CONFIGURATION_INVALID");
  base.hash = "/settings?section=notifications";
  const preferences = base.href;
  const ar = d.language === "ar";
  let subject: string, text: string;
  if (d.kind === "review_digest") {
    subject = ar
      ? "TenderDesk: لديك طلبات بانتظار المراجعة"
      : "TenderDesk: items are waiting for review";
    base.hash = "/review";
    text = ar
      ? `لديك ${d.payload.discoveries || 0} فرصة في المراجعة و${d.payload.proposals || 0} عرض يحتاج مراجعة.\n${base.href}`
      : `You have ${d.payload.discoveries || 0} discoveries and ${d.payload.proposals || 0} proposals awaiting review.\n${base.href}`;
    if (d.payload.proposals) {
      base.hash = "/proposals";
      text += `\n${base.href}`;
    }
  } else if (d.kind === "processing_failure") {
    subject = ar
      ? "TenderDesk: مشكلة مستمرة في المعالجة"
      : "TenderDesk: processing needs attention";
    base.hash = "/jobs";
    text = `${d.payload.title || "Processing needs attention"}\n${d.payload.detail || ""}\n${base.href}`;
  } else {
    subject = ar
      ? "TenderDesk: اختبار بريد التنبيهات"
      : "TenderDesk: notification email test";
    text = ar
      ? "تم إرسال هذه الرسالة لاختبار إعداد بريد التنبيهات."
      : "This message tests your notification email configuration.";
  }
  return {
    from: smtp.from,
    to: d.recipient,
    subject,
    text: `${text}\n\n${ar ? "تفضيلات الإشعارات" : "Notification preferences"}: ${preferences}`,
    // A stable identity helps mail clients correlate an SMTP retry. It is not
    // a claim that SMTP provides an exactly-once delivery guarantee.
    messageId: `<tenderdesk-${d.id}@${senderAddress(smtp.from)!.split("@")[1]}>`,
  };
}

export type MailSender = (
  message: ReturnType<typeof notificationMessage>,
) => Promise<{ messageId?: string; accepted?: unknown[] }>;
export function smtpSender(env: BackendEnvironment): MailSender {
  const s = env.smtp!;
  return async (message) => {
    const implicitTls = s.port === 465 || s.port === 2465;
    const transport = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: implicitTls,
      requireTLS: !implicitTls,
      auth: { user: s.user, pass: s.password },
      tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    try {
      return await transport.sendMail(message);
    } finally {
      transport.close();
    }
  };
}

export function smtpFailure(error: unknown): {
  outcome: "retry" | "failed" | "unknown";
  code: string;
} {
  const e = error as { code?: string; command?: string; responseCode?: number };
  const code = e?.code || "";
  const response = e?.responseCode;
  if (code === "EAUTH") return { outcome: "failed", code: "SMTP_AUTH_FAILED" };
  if (response && response >= 400 && response < 500)
    return { outcome: "retry", code: "SMTP_TEMPORARY_REJECTION" };
  if (response && response >= 500)
    return { outcome: "failed", code: "SMTP_REJECTED" };
  if (
    [
      "CONN",
      "EHLO",
      "HELO",
      "STARTTLS",
      "AUTH",
      "MAIL FROM",
      "RCPT TO",
    ].includes(e?.command || "") ||
    ["EDNS", "ECONNECTION"].includes(code)
  )
    return { outcome: "retry", code: "SMTP_CONNECTION_FAILED" };
  // A timeout during/after DATA can mean the message was accepted. Do not
  // resend silently; retain an explicit unknown-delivery record in the app.
  return { outcome: "unknown", code: "SMTP_DELIVERY_UNCONFIRMED" };
}

export async function processNotificationEmail(
  backend: Backend,
  env: BackendEnvironment,
  send?: MailSender,
) {
  if (!smtpStatus(env).configured) return;
  const d = (await backend.internal(
    "claim_notification_delivery",
  )) as Delivery | null;
  if (!d) return;
  let result: {
    outcome: string;
    result_code: string | null;
    remote_message_id: string | null;
  };
  try {
    const sent = await (send || smtpSender(env))(notificationMessage(d, env));
    if (!sent.accepted?.length) throw { responseCode: 550 };
    result = {
      outcome: "sent",
      result_code: null,
      remote_message_id: sent.messageId?.slice(0, 300) || null,
    };
  } catch (error) {
    const failure = smtpFailure(error);
    result = {
      outcome: failure.outcome,
      result_code: failure.code,
      remote_message_id: null,
    };
  }
  // Keep DB acknowledgement errors separate from SMTP results. An accepted
  // message must not be treated as a rejected send and retried a second time.
  await backend.internal("finish_notification_delivery", {
    delivery_id: d.id,
    lease: d.lease_token,
    ...result,
  });
}
