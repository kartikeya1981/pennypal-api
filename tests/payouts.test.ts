import { beforeEach, describe, expect, it } from "vitest"
import { longestMonthStreak } from "../src/badges"
import { db } from "../src/db"
import { as, factories, registerUser } from "./helpers"

let api: ReturnType<typeof as>
let kidId: string

const account = async () => (await api.get(`/kids/${kidId}/account`)).body
const statement = async () => (await api.get(`/kids/${kidId}/statement`)).body
const earned = async () =>
  ((await api.get(`/kids/${kidId}/badges`)).body as { code: string; earnedAt: string | null }[])
    .filter((b) => b.earnedAt)
    .map((b) => b.code)

async function addGoal(o: Record<string, unknown> = {}) {
  return (await api.post(`/kids/${kidId}/goals`).send({ name: "Bike", emoji: "🚲", targetAmount: 100, ...o })).body as {
    id: string
  }
}

const extra = (amount: number, goalId?: string) =>
  api.post(`/kids/${kidId}/earnings`).send({ kind: "EXTRA", amount, note: "Gift", goalId })

beforeEach(async () => {
  api = as((await registerUser()).token)
  kidId = (await api.post("/kids").send(factories.kid({ monthlyEarning: 500 }))).body.id
})

describe("payouts", () => {
  it("cashes out from the Wallet and shows on the statement", async () => {
    await extra(300)
    const res = await api.post(`/kids/${kidId}/payouts`).send({ amount: "120", goalId: "", note: "Ice cream" })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ total: 180, wallet: 180, achieved: false })
    const [row] = await statement()
    expect(row).toMatchObject({ type: "PAYOUT", note: "Ice cream", amount: -120, balanceAfter: 180 })
    expect(row.legs).toEqual([{ goalId: null, goalName: null, goalEmoji: null, amount: -120 }])
  })

  it("never overdraws a pot", async () => {
    const bike = await addGoal()
    await extra(50)
    await extra(30, bike.id)
    for (const [body, error] of [
      [{ amount: 51 }, "Only 50 Kid Coins in the Wallet"],
      [{ amount: 31, goalId: bike.id }, "Only 30 Kid Coins in Bike"],
      [{ amount: 0 }, "Amount must be at least 1"],
      [{ amount: 1.5 }, "Amount must be a whole number"],
      [{ amount: 1, note: "x".repeat(81) }, "Note must be at most 80 characters"],
      [{ amount: 1, goalId: "nope" }, "Unknown goal"],
    ] as const) {
      const res = await api.post(`/kids/${kidId}/payouts`).send(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error).toBe(error)
    }
    expect(await account()).toMatchObject({ total: 80, wallet: 50 })
  })

  it("lets only as many concurrent cash-outs through as the balance allows", async () => {
    await extra(100)
    const results = await Promise.all(
      Array.from({ length: 5 }, () => api.post(`/kids/${kidId}/payouts`).send({ amount: 30 }))
    )
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 201, 400, 400])
    expect(await account()).toMatchObject({ total: 10, wallet: 10 })
  })

  it("achieves a goal when its full jar is cashed out after reaching the target", async () => {
    const bike = await addGoal()
    const other = await addGoal({ name: "Book", targetAmount: 1000 })
    await api.put(`/kids/${kidId}/allocations`).send({ rules: [{ goalId: bike.id, type: "PERCENT", value: 50 }] })
    await extra(120, bike.id)
    expect((await account()).goals[0]).toMatchObject({ status: "READY", balance: 120 })

    // A partial cash-out drops it back below the target
    await api.post(`/kids/${kidId}/payouts`).send({ amount: 30, goalId: bike.id })
    expect((await account()).goals[0]).toMatchObject({ status: "ACTIVE", balance: 90 })
    await extra(10, bike.id)

    const res = await api.post(`/kids/${kidId}/payouts`).send({ amount: 100, goalId: bike.id, note: "Bought the bike" })
    expect(res.body.achieved).toBe(true)
    expect(res.body.goals[0]).toMatchObject({ status: "ACHIEVED", balance: 0, allocationType: "NONE" })
    expect(await earned()).toEqual(["FIRST_GOAL", "FIRST_PURCHASE"])

    // An achieved goal can't get more coins, a split rule or edits, but can be removed
    expect((await extra(5, bike.id)).body.error).toBe("Unknown goal")
    const move = await api.post(`/kids/${kidId}/transfers`).send({ amount: 1, toGoalId: bike.id })
    expect(move.body.error).toBe("Unknown goal")
    const rules = await api.put(`/kids/${kidId}/allocations`).send({ rules: [{ goalId: bike.id, type: "FIXED", value: 10 }] })
    expect(rules.body.error).toBe("Unknown goal")
    expect((await api.put(`/goals/${bike.id}`).send({ name: "Bike", targetAmount: 500 })).body.error).toBe(
      "This goal was already achieved"
    )
    const task = (await api.post(`/kids/${kidId}/tasks`).send({ title: "Read", reward: 5 })).body
    expect((await api.post(`/tasks/${task.id}/submit`).send({ rewardGoalId: bike.id })).body.error).toBe("Unknown goal")
    expect((await api.post(`/kids/${kidId}/allocations`).send({})).status).toBe(404)
    expect((await api.put(`/kids/${kidId}/allocations`).send({ rules: [{ goalId: other.id, type: "PERCENT", value: 10 }] })).status).toBe(200)
    expect((await api.delete(`/goals/${bike.id}`)).status).toBe(204)
    expect((await account()).goals.map((g: { id: string }) => g.id)).toEqual([other.id])
  })

  it("does not achieve a goal when cashing out a jar below its target", async () => {
    const bike = await addGoal()
    await extra(40, bike.id)
    const res = await api.post(`/kids/${kidId}/payouts`).send({ amount: 40, goalId: bike.id })
    expect(res.body.achieved).toBe(false)
    expect(res.body.goals[0]).toMatchObject({ status: "ACTIVE", balance: 0 })
  })
})

describe("transfers", () => {
  it("moves coins between the Wallet and goal jars", async () => {
    const bike = await addGoal()
    const book = await addGoal({ name: "Book", targetAmount: 50 })
    await extra(200)
    expect((await api.post(`/kids/${kidId}/transfers`).send({ amount: 120, fromGoalId: "", toGoalId: bike.id })).status).toBe(201)
    let acc = await account()
    expect(acc).toMatchObject({ total: 200, wallet: 80 })
    expect(acc.goals[0]).toMatchObject({ balance: 120, status: "READY" })

    await api.post(`/kids/${kidId}/transfers`).send({ amount: 50, fromGoalId: bike.id, toGoalId: book.id })
    await api.post(`/kids/${kidId}/transfers`).send({ amount: 10, fromGoalId: bike.id, note: "Changed my mind" })
    acc = await account()
    expect(acc.wallet).toBe(90)
    expect(acc.goals.map((g: { balance: number; status: string }) => [g.balance, g.status])).toEqual([
      [60, "ACTIVE"],
      [50, "READY"],
    ])
    const rows = await statement()
    expect(rows.slice(0, 3).map((r: { type: string; note: string; amount: number }) => [r.type, r.note, r.amount])).toEqual([
      ["TRANSFER", "Changed my mind", 0],
      ["TRANSFER", "Moved to Book", 0],
      ["TRANSFER", "Moved to Bike", 0],
    ])
    expect(rows[1].legs.map((l: { amount: number }) => l.amount)).toEqual([-50, 50])
    expect(rows[0].balanceAfter).toBe(200)
  })

  it("rejects bad moves", async () => {
    const bike = await addGoal()
    await extra(20)
    const other = as((await registerUser()).token)
    const otherKid = (await other.post("/kids").send(factories.kid())).body.id
    const otherGoal = (await other.post(`/kids/${otherKid}/goals`).send({ name: "X", targetAmount: 5 })).body.id
    for (const [body, error] of [
      [{ amount: 5 }, "Pick two different places"],
      [{ amount: 5, fromGoalId: bike.id, toGoalId: bike.id }, "Pick two different places"],
      [{ amount: 21, toGoalId: bike.id }, "Only 20 Kid Coins in the Wallet"],
      [{ amount: 1, fromGoalId: bike.id }, "Only 0 Kid Coins in Bike"],
      [{ amount: 1, toGoalId: otherGoal }, "Unknown goal"],
    ] as const) {
      const res = await api.post(`/kids/${kidId}/transfers`).send(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error).toBe(error)
    }
    expect((await other.post(`/kids/${kidId}/transfers`).send({ amount: 1, toGoalId: bike.id })).status).toBe(404)
    expect((await other.post(`/kids/${kidId}/payouts`).send({ amount: 1 })).status).toBe(404)
    expect((await other.get(`/kids/${kidId}/badges`)).status).toBe(404)
    expect(await account()).toMatchObject({ total: 20, wallet: 20 })
  })
})

describe("badges", () => {
  it("lists every badge, unearned ones with a null date", async () => {
    const badges = (await api.get(`/kids/${kidId}/badges`)).body
    expect(badges.map((b: { code: string }) => b.code)).toEqual(["FIRST_GOAL", "FIRST_PURCHASE", "TASKS_5", "SAVER_3"])
    expect(badges.every((b: { earnedAt: unknown; name: string }) => b.earnedAt === null && b.name)).toBe(true)
  })

  it("awards Helping hand after 5 approved tasks", async () => {
    for (let i = 0; i < 5; i++) {
      const task = (await api.post(`/kids/${kidId}/tasks`).send({ title: `Chore ${i}`, reward: 1 })).body
      await api.post(`/tasks/${task.id}/approve`).send({})
      expect(await earned()).toEqual(i < 4 ? [] : ["TASKS_5"])
    }
  })

  it("awards Super saver for goal jars growing 3 months in a row, and keeps badges once earned", async () => {
    const bike = await addGoal({ targetAmount: 10_000 })
    const kid = await db.kid.findUniqueOrThrow({ where: { id: kidId } })
    const months = [3, 2] // two earlier months; the current month comes from the earning below
    for (const back of months) {
      const d = new Date()
      d.setUTCDate(1)
      d.setUTCMonth(d.getUTCMonth() - back + 1)
      await db.ledgerEntry.create({
        data: { kidId, goalId: bike.id, amount: 10, type: "EXTRA_EARNING", groupId: `g${back}`, createdById: kid.parentId, createdAt: d },
      })
    }
    await extra(10, bike.id)
    expect(await earned()).toEqual(["SAVER_3"])
    await api.post(`/kids/${kidId}/transfers`).send({ amount: 30, fromGoalId: bike.id })
    expect(await earned()).toEqual(["SAVER_3"])
  })

  it("counts consecutive months across years", () => {
    expect(longestMonthStreak([])).toBe(0)
    expect(longestMonthStreak(["2026-01", "2026-03", "2026-04"])).toBe(2)
    expect(longestMonthStreak(["2026-12", "2025-11", "2025-12", "2026-01"])).toBe(3)
    expect(longestMonthStreak(["2026-05", "2026-05", "2026-06"])).toBe(2)
  })
})
