export const money = (value: number | null, currency = "SAR") =>
  value === null
    ? "Not provided"
    : new Intl.NumberFormat("en-SA", {
        style: "currency",
        currency,
        maximumFractionDigits: 0,
      }).format(value);
export const shortMoney = (value: number) =>
  value >= 1e6
    ? `${(value / 1e6).toFixed(1)}M`
    : value >= 1000
      ? `${Math.round(value / 1000)}K`
      : `${value}`;
export function date(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "Asia/Riyadh",
      }).format(new Date(value))
    : "Not provided";
}
export function daysLeft(value: string) {
  return value
    ? Math.ceil((new Date(value).getTime() - Date.now()) / 86400000)
    : Infinity;
}
export function deadlineLabel(value: string) {
  if (!value) return "Not provided";
  const days = daysLeft(value);
  return days < 0
    ? "Deadline passed"
    : days === 0
      ? "Due today"
      : `${days} days left`;
}
export const uid = (_prefix = "id") => crypto.randomUUID();
