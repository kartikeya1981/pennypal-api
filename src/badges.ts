import { db } from "./db"
import { isUniqueViolation } from "./ledger"

export const BADGES = [
  { code: "FIRST_GOAL", emoji: "🎯", name: "Goal getter", description: "Saved the full amount for a goal" },
  { code: "FIRST_PURCHASE", emoji: "🛍️", name: "Dream come true", description: "Cashed out a goal you saved for" },
  { code: "TASKS_5", emoji: "🦸", name: "Helping hand", description: "Got 5 tasks approved" },
  { code: "SAVER_3", emoji: "🐷", name: "Super saver", description: "Added to your goals 3 months in a row" },
] as const

export type BadgeCode = (typeof BADGES)[number]["code"]

/** Longest run of consecutive calendar months in a list of "YYYY-MM" keys. */
export function longestMonthStreak(months: string[]) {
  const idx = [...new Set(months)].map((m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7))).sort((a, b) => a - b)
  let best = 0
  let run = 0
  idx.forEach((v, i) => {
    run = i > 0 && v === idx[i - 1] + 1 ? run + 1 : 1
    best = Math.max(best, run)
  })
  return best
}

async function earnedCodes(kidId: string) {
  const [goals, tasksDone, jarEntries] = await Promise.all([
    db.goal.findMany({ where: { kidId, status: { in: ["READY", "ACHIEVED"] } }, select: { status: true } }),
    db.task.count({ where: { kidId, status: "APPROVED" } }),
    db.ledgerEntry.findMany({ where: { kidId, goalId: { not: null } }, select: { amount: true, createdAt: true } }),
  ])
  const netByMonth = new Map<string, number>()
  for (const e of jarEntries) {
    const m = e.createdAt.toISOString().slice(0, 7)
    netByMonth.set(m, (netByMonth.get(m) ?? 0) + e.amount)
  }
  const saved = [...netByMonth].filter(([, net]) => net > 0).map(([m]) => m)
  const earned = new Set<BadgeCode>()
  if (goals.length) earned.add("FIRST_GOAL")
  if (goals.some((g) => g.status === "ACHIEVED")) earned.add("FIRST_PURCHASE")
  if (tasksDone >= 5) earned.add("TASKS_5")
  if (longestMonthStreak(saved) >= 3) earned.add("SAVER_3")
  return earned
}

/** Stores any badges the kid has newly earned. Badges are never taken away. */
export async function awardBadges(kidId: string) {
  const [earned, have] = await Promise.all([earnedCodes(kidId), db.badge.findMany({ where: { kidId }, select: { code: true } })])
  const owned = new Set(have.map((b) => b.code))
  for (const code of earned) {
    if (owned.has(code)) continue
    await db.badge.create({ data: { kidId, code } }).catch((e) => {
      if (!isUniqueViolation(e)) throw e
    })
  }
}

/** Every badge, with when this kid earned it (null = not yet). */
export async function kidBadges(kidId: string) {
  const rows = await db.badge.findMany({ where: { kidId } })
  const at = new Map(rows.map((b) => [b.code, b.earnedAt]))
  return BADGES.map((b) => ({ ...b, earnedAt: at.get(b.code) ?? null }))
}
