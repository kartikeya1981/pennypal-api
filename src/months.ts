/** "2026-10" for a date (UTC). */
export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7)

/** "2026-10" -> "October 2026" */
export const monthLabel = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })

const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate()

/** This month's earning date (UTC midnight). Days 29–31 fall back to the last day of shorter months. */
export function earningDate(earningDay: number, now = new Date()) {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  return new Date(Date.UTC(y, m, Math.min(earningDay, lastDay(y, m))))
}
