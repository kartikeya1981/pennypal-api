import { beforeEach, describe, expect, it } from "vitest"
import request from "supertest"
import { app, as, factories, registerUser, type TestUser } from "./helpers"

const month = () => new Date().toISOString().slice(0, 7)

let parent: TestUser
let api: ReturnType<typeof as>
let kidId: string

async function addGoal(o: Record<string, unknown> = {}) {
  const res = await api.post(`/kids/${kidId}/goals`).send({ name: "Video game", emoji: "🎮", targetAmount: 1000, ...o })
  expect(res.status).toBe(201)
  return res.body as { id: string; name: string }
}

const account = async () => (await api.get(`/kids/${kidId}/account`)).body

beforeEach(async () => {
  parent = await registerUser()
  api = as(parent.token)
  kidId = (await api.post("/kids").send(factories.kid({ monthlyEarning: 500 }))).body.id
})

describe("goals", () => {
  it("creates, lists, updates and archives goals", async () => {
    const goal = await addGoal()
    expect(goal).toMatchObject({ name: "Video game", emoji: "🎮", targetAmount: 1000, status: "ACTIVE", balance: 0 })
    expect((await api.get(`/kids/${kidId}/goals`)).body).toHaveLength(1)

    const upd = await api.put(`/goals/${goal.id}`).send({ name: "Tennis racket", emoji: "🎾", targetAmount: "2500" })
    expect(upd.status).toBe(200)
    expect(upd.body).toMatchObject({ name: "Tennis racket", targetAmount: 2500 })

    expect((await api.delete(`/goals/${goal.id}`)).status).toBe(204)
    expect((await api.get(`/kids/${kidId}/goals`)).body).toEqual([])
    expect((await api.put(`/goals/${goal.id}`).send({ name: "x", targetAmount: 1 })).status).toBe(404)
  })

  it("defaults the emoji and validates input", async () => {
    expect((await addGoal({ emoji: "" })).name).toBe("Video game")
    expect((await api.get(`/kids/${kidId}/goals`)).body[0].emoji).toBe("🎯")
    for (const [body, error] of [
      [{ name: "", targetAmount: 10 }, "Goal name is required"],
      [{ name: "x".repeat(41), targetAmount: 10 }, "Goal name must be at most 40 characters"],
      [{ name: "Bike", targetAmount: 0 }, "Target must be at least 1"],
      [{ name: "Bike", targetAmount: 1.5 }, "Target must be a whole number"],
      [{ name: "Bike", targetAmount: 10, emoji: "🎮🎾" }, "Pick a single emoji"],
    ] as const) {
      const res = await api.post(`/kids/${kidId}/goals`).send(body)
      expect(res.status).toBe(400)
      expect(res.body.error).toBe(error)
    }
  })

  it("moves an archived goal's coins back to the Wallet", async () => {
    const goal = await addGoal()
    await api.post(`/kids/${kidId}/earnings`).send({ kind: "EXTRA", amount: 300, note: "Gift", goalId: goal.id })
    await api.delete(`/goals/${goal.id}`)
    expect(await account()).toMatchObject({ total: 300, wallet: 300, goals: [] })
    const [transfer] = (await api.get(`/kids/${kidId}/statement`)).body
    expect(transfer).toMatchObject({ type: "TRANSFER", amount: 0, balanceAfter: 300, note: "Goal removed: Video game" })
  })
})

describe("allocation rules", () => {
  it("replaces the rule set and validates totals", async () => {
    const a = await addGoal()
    const b = await addGoal({ name: "Shoes" })
    const ok = await api.put(`/kids/${kidId}/allocations`).send({
      rules: [
        { goalId: a.id, type: "FIXED", value: 200 },
        { goalId: b.id, type: "PERCENT", value: "50" },
      ],
    })
    expect(ok.status).toBe(200)
    expect(ok.body.map((g: { allocationType: string; allocationValue: number }) => [g.allocationType, g.allocationValue])).toEqual([
      ["FIXED", 200],
      ["PERCENT", 50],
    ])
    expect((await api.get(`/kids/${kidId}/allocations/preview`)).body).toEqual({
      shares: [
        { goalId: a.id, amount: 200 },
        { goalId: b.id, amount: 150 },
      ],
      wallet: 150,
    })

    const cleared = await api.put(`/kids/${kidId}/allocations`).send({ rules: [{ goalId: b.id, type: "PERCENT", value: 10 }] })
    expect(cleared.body[0]).toMatchObject({ allocationType: "NONE", allocationValue: 0 })

    for (const [rules, error] of [
      [[{ goalId: a.id, type: "PERCENT", value: 60 }, { goalId: b.id, type: "PERCENT", value: 50 }], "Percentages add up to more than 100%"],
      [[{ goalId: a.id, type: "FIXED", value: 501 }], "Fixed amounts add up to more than the Monthly Earning (500 Kid Coins)"],
      [[{ goalId: a.id, type: "PERCENT", value: 0 }], "Percent must be between 1 and 100"],
      [[{ goalId: a.id, type: "FIXED", value: 1 }, { goalId: a.id, type: "FIXED", value: 1 }], "Each goal can only have one rule"],
      [[{ goalId: "nope", type: "FIXED", value: 1 }], "Unknown goal"],
      [[{ goalId: a.id, type: "HALF", value: 1 }], "Choose None, % or Fixed"],
    ] as const) {
      const res = await api.put(`/kids/${kidId}/allocations`).send({ rules })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe(error)
    }
  })
})

describe("earnings and statement", () => {
  it("credits the Monthly Earning once per month and auto-splits it", async () => {
    const a = await addGoal({ targetAmount: 1000 })
    const b = await addGoal({ name: "Shoes", targetAmount: 120 })
    await api.put(`/kids/${kidId}/allocations`).send({
      rules: [
        { goalId: a.id, type: "PERCENT", value: 50 },
        { goalId: b.id, type: "FIXED", value: 200 },
      ],
    })
    const res = await api.post(`/kids/${kidId}/earnings`).send({ kind: "MONTHLY", month: month() })
    expect(res.status).toBe(201)
    // Shoes only needs 120; 50% of the remaining 380 = 190 to the game; 190 stays in the Wallet
    expect(res.body).toMatchObject({
      total: 500,
      wallet: 190,
      goals: [
        { id: a.id, balance: 190, status: "ACTIVE" },
        { id: b.id, balance: 120, status: "READY" },
      ],
    })

    const again = await api.post(`/kids/${kidId}/earnings`).send({ kind: "MONTHLY", month: month() })
    expect(again.status).toBe(409)
    expect(again.body.error).toMatch(/Monthly Earning was already added/)
    expect((await account()).creditedMonths).toEqual([month()])

    const [row] = (await api.get(`/kids/${kidId}/statement`)).body
    expect(row).toMatchObject({ type: "MONTHLY_EARNING", amount: 500, balanceAfter: 500 })
    expect(row.legs).toEqual(
      expect.arrayContaining([
        { goalId: null, goalName: null, goalEmoji: null, amount: 190 },
        { goalId: a.id, goalName: "Video game", goalEmoji: "🎮", amount: 190 },
        { goalId: b.id, goalName: "Shoes", goalEmoji: "🎮", amount: 120 },
      ])
    )
  })

  it("never double-credits a month under concurrent requests", async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => api.post(`/kids/${kidId}/earnings`).send({ kind: "MONTHLY", month: "2026-01" }))
    )
    expect(results.filter((r) => r.status === 201)).toHaveLength(1)
    expect((await account()).total).toBe(500)
  })

  it("rejects future months, bad months and kids without an earning", async () => {
    const future = await api.post(`/kids/${kidId}/earnings`).send({ kind: "MONTHLY", month: "2999-01" })
    expect(future.body.error).toBe("You can't add a Monthly Earning for a future month")
    expect((await api.post(`/kids/${kidId}/earnings`).send({ kind: "MONTHLY", month: "2026-13" })).body.error).toBe(
      "Month must look like 2026-10"
    )
    const zero = (await api.post("/kids").send(factories.kid({ monthlyEarning: 0 }))).body.id
    const res = await api.post(`/kids/${zero}/earnings`).send({ kind: "MONTHLY", month: month() })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("Set a Monthly Earning for this kid first")
  })

  it("adds extra earnings to the Wallet or straight into a goal", async () => {
    const goal = await addGoal({ targetAmount: 100 })
    await api.put(`/kids/${kidId}/allocations`).send({ rules: [{ goalId: goal.id, type: "PERCENT", value: 100 }] })
    await api.post(`/kids/${kidId}/earnings`).send({ kind: "EXTRA", amount: "75", note: "Birthday gift", goalId: "" })
    expect(await account()).toMatchObject({ total: 75, wallet: 75, goals: [{ balance: 0 }] })

    await api.post(`/kids/${kidId}/earnings`).send({ kind: "EXTRA", amount: 100, note: "Read a book", goalId: goal.id })
    expect(await account()).toMatchObject({ total: 175, wallet: 75, goals: [{ balance: 100, status: "READY" }] })

    const rows = (await api.get(`/kids/${kidId}/statement`)).body
    expect(rows.map((r: { note: string; amount: number; balanceAfter: number }) => [r.note, r.amount, r.balanceAfter])).toEqual([
      ["Read a book", 100, 175],
      ["Birthday gift", 75, 75],
    ])

    for (const [body, error] of [
      [{ kind: "EXTRA", amount: 0, note: "x" }, "Amount must be at least 1"],
      [{ kind: "EXTRA", amount: 10, note: "" }, "What it's for is required"],
      [{ kind: "EXTRA", amount: 10, note: "x", goalId: "nope" }, "Unknown goal"],
    ] as const) {
      const res = await api.post(`/kids/${kidId}/earnings`).send(body)
      expect(res.status).toBe(400)
      expect(res.body.error).toBe(error)
    }
  })

  it("lowers a READY goal back to ACTIVE when its target is raised", async () => {
    const goal = await addGoal({ targetAmount: 50 })
    await api.post(`/kids/${kidId}/earnings`).send({ kind: "EXTRA", amount: 50, note: "Chores", goalId: goal.id })
    expect((await account()).goals[0].status).toBe("READY")
    const res = await api.put(`/goals/${goal.id}`).send({ name: "Video game", targetAmount: 80 })
    expect(res.body).toMatchObject({ status: "ACTIVE", balance: 50 })
  })
})

describe("kid list", () => {
  it("includes each kid's total balance", async () => {
    await api.post(`/kids/${kidId}/earnings`).send({ kind: "EXTRA", amount: 40, note: "Chores" })
    await api.post("/kids").send(factories.kid({ name: "Meera" }))
    const kids = (await api.get("/kids")).body
    expect(kids.map((k: { name: string; balance: number }) => [k.name, k.balance])).toEqual([
      ["Aarav", 40],
      ["Meera", 0],
    ])
  })
})

describe("isolation", () => {
  it("hides another family's goals, account and statement", async () => {
    const goal = await addGoal()
    const other = as((await registerUser()).token)
    for (const path of [`/kids/${kidId}/account`, `/kids/${kidId}/goals`, `/kids/${kidId}/statement`]) {
      expect((await other.get(path)).status).toBe(404)
    }
    expect((await other.post(`/kids/${kidId}/goals`).send({ name: "x", targetAmount: 1 })).status).toBe(404)
    expect((await other.post(`/kids/${kidId}/earnings`).send({ kind: "EXTRA", amount: 1, note: "x" })).status).toBe(404)
    expect((await other.put(`/kids/${kidId}/allocations`).send({ rules: [] })).status).toBe(404)
    expect((await other.put(`/goals/${goal.id}`).send({ name: "x", targetAmount: 1 })).status).toBe(404)
    expect((await other.delete(`/goals/${goal.id}`)).status).toBe(404)
  })

  it("won't credit another kid's goal from this kid", async () => {
    const otherApi = as((await registerUser()).token)
    const otherKid = (await otherApi.post("/kids").send(factories.kid())).body.id
    const otherGoal = (await otherApi.post(`/kids/${otherKid}/goals`).send({ name: "x", targetAmount: 10 })).body.id
    const res = await api.post(`/kids/${kidId}/earnings`).send({ kind: "EXTRA", amount: 5, note: "x", goalId: otherGoal })
    expect(res.body.error).toBe("Unknown goal")
  })

  it("requires sign-in", async () => {
    expect((await request(app).get(`/kids/${kidId}/statement`)).status).toBe(401)
    expect((await request(app).delete("/goals/x")).status).toBe(401)
  })
})
