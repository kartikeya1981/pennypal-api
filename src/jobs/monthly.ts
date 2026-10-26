import type { Prisma } from "@prisma/client"
import { db } from "../db"
import { HttpError } from "../errors"
import { credit } from "../ledger"
import { earningDate, monthKey, monthLabel } from "../months"

const DAY = 86_400_000

/**
 * Credits (and auto-splits) this month's Monthly Earning for every kid whose earning day has arrived.
 * Safe to run any number of times: the `monthly:{kidId}:{YYYY-MM}` key allows one credit per month.
 * Kids added after this month's earning day start next month.
 */
export async function runMonthlyEarnings(now = new Date(), scope: Prisma.KidWhereInput = {}) {
  const month = monthKey(now)
  const kids = await db.kid.findMany({ where: { ...scope, monthlyEarning: { gt: 0 } } })
  let credited = 0
  for (const kid of kids) {
    const due = earningDate(kid.earningDay, now)
    if (now < due || kid.createdAt.getTime() >= due.getTime() + DAY) continue
    try {
      await credit({
        kidId: kid.id,
        createdById: kid.parentId,
        amount: kid.monthlyEarning,
        type: "MONTHLY_EARNING",
        note: monthLabel(month),
        autoAllocate: true,
        idempotencyKey: `monthly:${kid.id}:${month}`,
      })
      credited += 1
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 409)) console.error(`Monthly Earning failed for kid ${kid.id}`, e)
    }
  }
  return credited
}

/** Runs the job now and then every hour. */
export function startMonthlyScheduler(intervalMs = 60 * 60 * 1000) {
  const tick = () => {
    runMonthlyEarnings()
      .then((n) => n && console.log(`Credited ${n} Monthly Earning(s)`))
      .catch((e) => console.error("Monthly Earning job failed", e))
  }
  tick()
  return setInterval(tick, intervalMs).unref()
}
