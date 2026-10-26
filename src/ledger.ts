import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import { db } from "./db"
import { awardBadges } from "./badges"
import { HttpError } from "./errors"

export type EntryType = "MONTHLY_EARNING" | "EXTRA_EARNING" | "TASK_EARNING" | "TRANSFER" | "PAYOUT"
export type AllocationType = "NONE" | "PERCENT" | "FIXED"

type Tx = Prisma.TransactionClient

const inLock = new AsyncLocalStorage<boolean>()
let queue: Promise<unknown> = Promise.resolve()

/**
 * Runs ledger writes one at a time. SQLite can't run concurrent write transactions reliably, and
 * overdraw checks must see every earlier write. Nested calls run inside the outer lock.
 * (A Postgres deployment could use row locks instead.)
 */
export function serialize<T>(fn: () => Promise<T>): Promise<T> {
  if (inLock.getStore()) return fn()
  const locked = () => inLock.run(true, fn)
  const run = queue.then(locked, locked)
  queue = run.catch(() => undefined)
  return run
}

const kc = (n: number) => `${n.toLocaleString("en-IN")} ${n === 1 ? "Kid Coin" : "Kid Coins"}`

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
  type: Exclude<EntryType, "TRANSFER" | "PAYOUT">
  note?: string | null
  /** Credit straight into this goal's jar instead of the Wallet + auto-split. */
  goalId?: string | null
  autoAllocate?: boolean
  idempotencyKey?: string
}

/** Credits Kid Coins in one transaction. Throws 409 if the idempotency key was already used. */
export function credit(c: Credit) {
  return serialize(async () => {
    const groupId = await writeCredit(c)
    await awardBadges(c.kidId)
    return groupId
  })
}

async function writeCredit(c: Credit) {
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
  await serialize(() => db.$transaction(async (tx) => {
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
  }))
}

async function pot(tx: Tx, kidId: string, goalId: string | null | undefined, statuses: string[]) {
  if (!goalId) return null
  const goal = await tx.goal.findFirst({
    where: { id: goalId, kidId, status: { in: statuses } },
  })
  if (!goal) throw new HttpError(400, "Unknown goal")
  return goal
}

const NOT_ARCHIVED = ["ACTIVE", "READY", "ACHIEVED"]

function checkFunds(amount: number, available: number, from: { name: string } | null) {
  if (amount > available) throw new HttpError(400, `Only ${kc(available)} in ${from ? from.name : "the Wallet"}`)
}

type Payout = {
  kidId: string
  createdById: string
  amount: number
  goalId?: string | null
  note?: string | null
}

/**
 * Records real money handed over by the parent as a debit from the Wallet or a goal jar.
 * Cashing out the whole jar of a goal that reached its target marks the goal ACHIEVED.
 */
export function payout(p: Payout) {
  return serialize(async () => {
    const achieved = await db.$transaction(async (tx) => {
      const goal = await pot(tx, p.kidId, p.goalId, NOT_ARCHIVED)
      const { wallet, byGoal } = await balances(tx, p.kidId)
      const available = goal ? (byGoal.get(goal.id) ?? 0) : wallet
      checkFunds(p.amount, available, goal)
      await tx.ledgerEntry.create({
        data: {
          kidId: p.kidId,
          createdById: p.createdById,
          type: "PAYOUT",
          groupId: randomUUID(),
          note: p.note ?? null,
          goalId: goal?.id ?? null,
          amount: -p.amount,
        },
      })
      const done = !!goal && goal.status !== "ACHIEVED" && p.amount === available && available >= goal.targetAmount
      if (done) {
        await tx.goal.update({
          where: { id: goal.id },
          data: {
            status: "ACHIEVED",
            allocationType: "NONE",
            allocationValue: 0,
          },
        })
      }
      await refreshGoalStatuses(tx, p.kidId)
      return done
    })
    await awardBadges(p.kidId)
    return { achieved }
  })
}

type Transfer = {
  kidId: string
  createdById: string
  amount: number
  fromGoalId?: string | null
  toGoalId?: string | null
  note?: string | null
}

/** Moves Kid Coins between the Wallet and goal jars (or between two jars). */
export function transfer(t: Transfer) {
  return serialize(async () => {
    await db.$transaction(async (tx) => {
      if ((t.fromGoalId ?? null) === (t.toGoalId ?? null)) throw new HttpError(400, "Pick two different places")
      const from = await pot(tx, t.kidId, t.fromGoalId, NOT_ARCHIVED)
      const to = await pot(tx, t.kidId, t.toGoalId, ["ACTIVE", "READY"])
      const { wallet, byGoal } = await balances(tx, t.kidId)
      checkFunds(t.amount, from ? (byGoal.get(from.id) ?? 0) : wallet, from)
      const base = {
        kidId: t.kidId,
        createdById: t.createdById,
        type: "TRANSFER",
        groupId: randomUUID(),
        note: t.note || `Moved to ${to ? to.name : "Wallet"}`,
      }
      await tx.ledgerEntry.create({
        data: { ...base, goalId: from?.id ?? null, amount: -t.amount },
      })
      await tx.ledgerEntry.create({
        data: { ...base, goalId: to?.id ?? null, amount: t.amount },
      })
      await refreshGoalStatuses(tx, t.kidId)
    })
    await awardBadges(t.kidId)
  })
}
