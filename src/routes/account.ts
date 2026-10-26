import { Router, type Request } from "express"
import { z } from "zod"
import { userId } from "../auth"
import { db } from "../db"
import { HttpError } from "../errors"
import { kidBadges } from "../badges"
import { allocate, balances, credit, payout, transfer } from "../ledger"
import { monthKey, monthLabel } from "../months"
import { int, parse, str } from "../validation"
import { emoji } from "./kids"

export const MAX_GOAL_TARGET = 10_000_000
export const MAX_EXTRA_EARNING = 1_000_000

export async function ownedKid(req: Request, id: string) {
  const kid = await db.kid.findFirst({ where: { id, parentId: userId(req) } })
  if (!kid) throw new HttpError(404, "Not found")
  return kid
}

export const goalSchema = z.object({
  name: str("Goal name", 40),
  emoji: emoji("Pick a single emoji", "🎯"),
  targetAmount: int("Target", { min: 1, max: MAX_GOAL_TARGET }),
})

/** Non-archived goals with their jar balance and progress. */
export async function goalsWithBalances(kidId: string) {
  const [goals, { byGoal, wallet, total }] = await Promise.all([
    db.goal.findMany({ where: { kidId, status: { not: "ARCHIVED" } }, orderBy: { createdAt: "asc" } }),
    balances(db, kidId),
  ])
  return {
    total,
    wallet,
    goals: goals.map((g) => ({ ...g, balance: byGoal.get(g.id) ?? 0 })),
  }
}

const earningSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("MONTHLY"),
    month: z
      .string({ message: "Month is required" })
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month must look like 2026-10")
      .refine((m) => m <= monthKey(), "You can't add a Monthly Earning for a future month"),
  }),
  z.object({
    kind: z.literal("EXTRA"),
    amount: int("Amount", { min: 1, max: MAX_EXTRA_EARNING }),
    note: str("What it's for", 80),
    goalId: z.preprocess((v) => (v === "" ? null : v), z.string().nullish()),
  }),
])

/** A Wallet-or-goal field: "" (or missing) means the Wallet. */
const pot = z.preprocess((v) => (v === "" ? null : v), z.string().nullish())
const optionalNote = z.preprocess((v) => (v === "" ? undefined : v), str("Note", 80).optional())

const payoutSchema = z.object({
  goalId: pot,
  amount: int("Amount", { min: 1, max: MAX_GOAL_TARGET }),
  note: optionalNote,
})

const transferSchema = z.object({
  fromGoalId: pot,
  toGoalId: pot,
  amount: int("Amount", { min: 1, max: MAX_GOAL_TARGET }),
  note: optionalNote,
})

const rulesSchema = z.object({
  rules: z.array(
    z.object({
      goalId: z.string({ message: "Goal is required" }),
      type: z.enum(["NONE", "PERCENT", "FIXED"], { message: "Choose None, % or Fixed" }),
      value: int("Amount"),
    })
  ),
})

export const accountRouter = Router()

accountRouter.get("/:id/account", async (req, res) => {
  const kid = await ownedKid(req, req.params.id as string)
  const credited = await db.ledgerEntry.findMany({
    where: { kidId: kid.id, idempotencyKey: { startsWith: `monthly:${kid.id}:` } },
    select: { idempotencyKey: true },
  })
  res.json({
    ...(await goalsWithBalances(kid.id)),
    creditedMonths: credited.map((e) => e.idempotencyKey!.split(":")[2]).sort(),
    currentMonth: monthKey(),
  })
})

accountRouter.get("/:id/goals", async (req, res) => {
  const kid = await ownedKid(req, req.params.id as string)
  res.json((await goalsWithBalances(kid.id)).goals)
})

accountRouter.post("/:id/goals", async (req, res) => {
  const kid = await ownedKid(req, req.params.id as string)
  const data = parse(goalSchema, req.body)
  const goal = await db.goal.create({ data: { ...data, kidId: kid.id } })
  res.status(201).json({ ...goal, balance: 0 })
})

accountRouter.put("/:id/allocations", async (req, res) => {
  const kid = await ownedKid(req, req.params.id as string)
  const { rules } = parse(rulesSchema, req.body)
  const goals = await db.goal.findMany({ where: { kidId: kid.id, status: { in: ["ACTIVE", "READY"] } } })
  const ids = new Set(goals.map((g) => g.id))
  const seen = new Set<string>()
  let percent = 0
  let fixed = 0
  for (const r of rules) {
    if (!ids.has(r.goalId)) throw new HttpError(400, "Unknown goal")
    if (seen.has(r.goalId)) throw new HttpError(400, "Each goal can only have one rule")
    seen.add(r.goalId)
    if (r.type === "PERCENT") {
      if (r.value < 1 || r.value > 100) throw new HttpError(400, "Percent must be between 1 and 100")
      percent += r.value
    }
    if (r.type === "FIXED") {
      if (r.value < 1) throw new HttpError(400, "Fixed amount must be at least 1")
      fixed += r.value
    }
  }
  if (percent > 100) throw new HttpError(400, "Percentages add up to more than 100%")
  if (fixed > kid.monthlyEarning)
    throw new HttpError(400, `Fixed amounts add up to more than the Monthly Earning (${kid.monthlyEarning} Kid Coins)`)
  const byId = new Map(rules.map((r) => [r.goalId, r]))
  await db.$transaction(
    goals.map((g) => {
      const r = byId.get(g.id)
      const type = r?.type ?? "NONE"
      return db.goal.update({
        where: { id: g.id },
        data: { allocationType: type, allocationValue: type === "NONE" ? 0 : r!.value },
      })
    })
  )
  res.json((await goalsWithBalances(kid.id)).goals)
})

/** Preview of how the next Monthly Earning would be split, without writing anything. */
accountRouter.get("/:id/allocations/preview", async (req, res) => {
  const kid = await ownedKid(req, req.params.id as string)
  const { goals } = await goalsWithBalances(kid.id)
  const active = goals.filter((g) => g.status === "ACTIVE" && g.allocationType !== "NONE")
  res.json(allocate(kid.monthlyEarning, active.map((g) => ({ ...g, remaining: g.targetAmount - g.balance }))))
})

accountRouter.post("/:id/earnings", async (req, res) => {
  const kid = await ownedKid(req, req.params.id as string)
  const data = parse(earningSchema, req.body)
  const createdById = userId(req)
  if (data.kind === "MONTHLY") {
    if (kid.monthlyEarning <= 0) throw new HttpError(400, "Set a Monthly Earning for this kid first")
    try {
      await credit({
        kidId: kid.id,
        createdById,
        amount: kid.monthlyEarning,
        type: "MONTHLY_EARNING",
        note: monthLabel(data.month),
        autoAllocate: true,
        idempotencyKey: `monthly:${kid.id}:${data.month}`,
      })
    } catch (e) {
      if (e instanceof HttpError && e.status === 409)
        throw new HttpError(409, `The ${monthLabel(data.month)} Monthly Earning was already added`)
      throw e
    }
  } else {
    if (data.goalId) {
      const goal = await db.goal.findFirst({ where: { id: data.goalId, kidId: kid.id, status: { in: ["ACTIVE", "READY"] } } })
      if (!goal) throw new HttpError(400, "Unknown goal")
    }
    await credit({
      kidId: kid.id,
      createdById,
      amount: data.amount,
      type: "EXTRA_EARNING",
      note: data.note,
      goalId: data.goalId ?? null,
    })
  }
  res.status(201).json(await goalsWithBalances(kid.id))
})

/** Real money handed to the kid: debits the Wallet or a goal jar. */
accountRouter.post("/:id/payouts", async (req, res) => {
  const kid = await ownedKid(req, req.params.id as string)
  const data = parse(payoutSchema, req.body)
  const { achieved } = await payout({ ...data, kidId: kid.id, createdById: userId(req) })
  res.status(201).json({ ...(await goalsWithBalances(kid.id)), achieved })
})

accountRouter.post("/:id/transfers", async (req, res) => {
  const kid = await ownedKid(req, req.params.id as string)
  const data = parse(transferSchema, req.body)
  await transfer({ ...data, kidId: kid.id, createdById: userId(req) })
  res.status(201).json(await goalsWithBalances(kid.id))
})

accountRouter.get("/:id/badges", async (req, res) => {
  const kid = await ownedKid(req, req.params.id as string)
  res.json(await kidBadges(kid.id))
})

type Leg = { goalId: string | null; goalName: string | null; goalEmoji: string | null; amount: number }

accountRouter.get("/:id/statement", async (req, res) => {
  const kid = await ownedKid(req, req.params.id as string)
  const entries = await db.ledgerEntry.findMany({
    where: { kidId: kid.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: { goal: { select: { name: true, emoji: true } } },
  })
  const groups = new Map<
    string,
    { id: string; type: string; note: string | null; createdAt: Date; amount: number; legs: Map<string, Leg> }
  >()
  for (const e of entries) {
    let g = groups.get(e.groupId)
    if (!g) {
      g = { id: e.groupId, type: e.type, note: e.note, createdAt: e.createdAt, amount: 0, legs: new Map() }
      groups.set(e.groupId, g)
    }
    g.amount += e.amount
    const key = e.goalId ?? "wallet"
    const leg = g.legs.get(key) ?? { goalId: e.goalId, goalName: e.goal?.name ?? null, goalEmoji: e.goal?.emoji ?? null, amount: 0 }
    leg.amount += e.amount
    g.legs.set(key, leg)
  }
  let running = 0
  const rows = [...groups.values()].map((g) => {
    running += g.amount
    return { ...g, balanceAfter: running, legs: [...g.legs.values()].filter((l) => l.amount !== 0) }
  })
  res.json(rows.reverse())
})

