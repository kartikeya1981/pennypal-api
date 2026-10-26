import { randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import { db } from "./db"
import { HttpError } from "./errors"

export type EntryType = "MONTHLY_EARNING" | "EXTRA_EARNING" | "TRANSFER"
export type AllocationType = "NONE" | "PERCENT" | "FIXED"

type Tx = Prisma.TransactionClient

export type AllocatableGoal = {
  id: string
  allocationType: string
  allocationValue: number
  /** Kid Coins still needed to reach the target */
  remaining: number
}

/**
 * Splits an earning across goal jars: FIXED amounts first (in goal order), then each
 * PERCENT goal takes its share of what is left after the fixed amounts (rounded down).
 * No goal gets more than it still needs; anything not allocated stays in the Wallet.
 */
export function allocate(amount: number, goals: AllocatableGoal[]) {
  const shares = new Map<string, number>()
  let left = amount
  const take = (goal: AllocatableGoal, want: number) => {
    const x = Math.max(0, Math.min(want, left, goal.remaining - (shares.get(goal.id) ?? 0)))
    if (x > 0) {
      shares.set(goal.id, (shares.get(goal.id) ?? 0) + x)
      left -= x
    }
  }
  for (const g of goals) if (g.allocationType === "FIXED") take(g, g.allocationValue)
  const base = left
  for (const g of goals) if (g.allocationType === "PERCENT") take(g, Math.floor((base * g.allocationValue) / 100))
  return { shares: [...shares].map(([goalId, amount]) => ({ goalId, amount })), wallet: left }
}

export async function balances(client: Tx | typeof db, kidId: string) {
  const rows = await client.ledgerEntry.groupBy({ by: ["goalId"], where: { kidId }, _sum: { amount: true } })
  const byGoal = new Map<string, number>()
  let wallet = 0
  for (const r of rows) {
    const sum = r._sum.amount ?? 0
    if (r.goalId) byGoal.set(r.goalId, sum)
    else wallet += sum
  }
  const total = wallet + [...byGoal.values()].reduce((a, b) => a + b, 0)
  return { total, wallet, byGoal }
}

/** Marks goals READY once their jar reaches the target, and back to ACTIVE if it drops below. */
export async function refreshGoalStatuses(tx: Tx, kidId: string) {
  const { byGoal } = await balances(tx, kidId)
  const goals = await tx.goal.findMany({ where: { kidId, status: { in: ["ACTIVE", "READY"] } } })
  for (const g of goals) {
    const status = (byGoal.get(g.id) ?? 0) >= g.targetAmount ? "READY" : "ACTIVE"
    if (status !== g.status) await tx.goal.update({ where: { id: g.id }, data: { status } })
  }
}

export const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002"

type Credit = {
  kidId: string
  createdById: string
  amount: number
  type: Extract<EntryType, "MONTHLY_EARNING" | "EXTRA_EARNING">
  note?: string | null
  /** Credit straight into this goal's jar instead of the Wallet + auto-split. */
  goalId?: string | null
  autoAllocate?: boolean
  idempotencyKey?: string
}

/** Credits Kid Coins in one transaction. Throws 409 if the idempotency key was already used. */
export async function credit(c: Credit) {
  const groupId = randomUUID()
  const base = { kidId: c.kidId, createdById: c.createdById, type: c.type, groupId, note: c.note ?? null }
  try {
    return await db.$transaction(async (tx) => {
      if (c.goalId) {
        await tx.ledgerEntry.create({
          data: { ...base, goalId: c.goalId, amount: c.amount, idempotencyKey: c.idempotencyKey },
        })
      } else {
        await tx.ledgerEntry.create({ data: { ...base, amount: c.amount, idempotencyKey: c.idempotencyKey } })
        if (c.autoAllocate) {
          const { byGoal } = await balances(tx, c.kidId)
          const goals = await tx.goal.findMany({
            where: { kidId: c.kidId, status: "ACTIVE", allocationType: { not: "NONE" } },
            orderBy: { createdAt: "asc" },
          })
          const { shares } = allocate(
            c.amount,
            goals.map((g) => ({ ...g, remaining: g.targetAmount - (byGoal.get(g.id) ?? 0) }))
          )
          for (const s of shares) {
            await tx.ledgerEntry.create({ data: { ...base, amount: -s.amount } })
            await tx.ledgerEntry.create({ data: { ...base, goalId: s.goalId, amount: s.amount } })
          }
        }
      }
      await refreshGoalStatuses(tx, c.kidId)
      return groupId
    })
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, "This earning was already added")
    throw e
  }
}

/** Moves a goal's whole jar back to the Wallet and archives the goal. */
export async function archiveGoal(goal: { id: string; kidId: string; name: string }, createdById: string) {
  await db.$transaction(async (tx) => {
    const { byGoal } = await balances(tx, goal.kidId)
    const amount = byGoal.get(goal.id) ?? 0
    if (amount > 0) {
      const base = {
        kidId: goal.kidId,
        createdById,
        type: "TRANSFER",
        groupId: randomUUID(),
        note: `Goal removed: ${goal.name}`,
      }
      await tx.ledgerEntry.create({ data: { ...base, goalId: goal.id, amount: -amount } })
      await tx.ledgerEntry.create({ data: { ...base, amount } })
    }
    await tx.goal.update({
      where: { id: goal.id },
      data: { status: "ARCHIVED", allocationType: "NONE", allocationValue: 0 },
    })
  })
}

