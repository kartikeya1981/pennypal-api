import { beforeEach, describe, expect, it } from "vitest"
import { db } from "../src/db"
import { runMonthlyEarnings } from "../src/jobs/monthly"
import { earningDate } from "../src/months"
import { as, factories, registerUser, type TestUser } from "./helpers"

let parent: TestUser
let api: ReturnType<typeof as>
let kidId: string

const account = async () => (await api.get(`/kids/${kidId}/account`)).body
async function addTask(o: Record<string, unknown> = {}) {
  const res = await api.post(`/kids/${kidId}/tasks`).send({ title: "Finish a book", reward: 50, ...o })
  expect(res.status).toBe(201)
  return res.body as { id: string; status: string }
}
async function addGoal(targetAmount = 1000) {
  return (await api.post(`/kids/${kidId}/goals`).send({ name: "Video game", targetAmount })).body as { id: string }
}

beforeEach(async () => {
  parent = await registerUser()
  api = as(parent.token)
  kidId = (await api.post("/kids").send(factories.kid({ monthlyEarning: 500, earningDay: 1 }))).body.id
})

describe("tasks", () => {
  it("creates, lists, edits and deletes tasks", async () => {
    const t = await addTask({ dueDate: "2026-11-01", recurrence: "WEEKLY" })
    expect(t).toMatchObject({ title: "Finish a book", reward: 50, status: "OPEN", recurrence: "WEEKLY" })
    expect((await api.get(`/kids/${kidId}/tasks`)).body).toHaveLength(1)
    const upd = await api.put(`/tasks/${t.id}`).send({ title: "Tidy room", reward: "20", dueDate: "" })
    expect(upd.body).toMatchObject({ title: "Tidy room", reward: 20, dueDate: null, recurrence: "NONE" })
    expect((await api.delete(`/tasks/${t.id}`)).status).toBe(204)
    expect((await api.get(`/kids/${kidId}/tasks`)).body).toEqual([])
  })

  it("validates input", async () => {
    for (const body of [
      { title: "", reward: 5 },
      { title: "x".repeat(61), reward: 5 },
      { title: "Read", reward: 0 },
      { title: "Read", reward: 2.5 },
      { title: "Read", reward: 100_001 },
      { title: "Read", reward: 5, dueDate: "31/10/2026" },
      { title: "Read", reward: 5, dueDate: "2026-13-45" },
      { title: "Read", reward: 5, recurrence: "DAILY" },
    ]) {
      expect((await api.post(`/kids/${kidId}/tasks`).send(body)).status, JSON.stringify(body)).toBe(400)
    }
  })

  it("submit -> approve pays the reward once, to the goal the kid picked", async () => {
    const goal = await addGoal(40)
    const t = await addTask()
    const sub = await api.post(`/tasks/${t.id}/submit`).send({ rewardGoalId: goal.id })
    expect(sub.body).toMatchObject({ status: "SUBMITTED", rewardGoalId: goal.id })
    expect((await api.post(`/tasks/${t.id}/submit`).send({})).status).toBe(400)

    const results = await Promise.all([1, 2, 3].map(() => api.post(`/tasks/${t.id}/approve`).send({})))
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409])
    const acc = await account()
    expect(acc.total).toBe(50)
    expect(acc.goals[0]).toMatchObject({ balance: 50, status: "READY" })
    const [row] = (await api.get(`/kids/${kidId}/statement`)).body
    expect(row).toMatchObject({ type: "TASK_EARNING", note: "Finish a book", amount: 50, balanceAfter: 50 })
    expect((await api.put(`/tasks/${t.id}`).send({ title: "x", reward: 1 })).status).toBe(400)
  })

  it("parent can approve an open task and change the destination; Wallet is the default", async () => {
    const goal = await addGoal()
    const a = await addTask()
    await api.post(`/tasks/${a.id}/submit`).send({ rewardGoalId: goal.id })
    expect((await api.post(`/tasks/${a.id}/approve`).send({ rewardGoalId: null })).body.rewardGoalId).toBeNull()
    const b = await addTask({ reward: 30 })
    expect((await api.post(`/tasks/${b.id}/approve`).send({})).status).toBe(200)
    expect(await account()).toMatchObject({ total: 80, wallet: 80 })
  })

  it("reject sends a task back to the kid", async () => {
    const goal = await addGoal()
    const t = await addTask()
    expect((await api.post(`/tasks/${t.id}/reject`).send({})).status).toBe(400)
    await api.post(`/tasks/${t.id}/submit`).send({ rewardGoalId: goal.id })
    expect((await api.post(`/tasks/${t.id}/reject`).send({})).body).toMatchObject({ status: "OPEN", rewardGoalId: null })
    expect((await account()).total).toBe(0)
  })

  it("rejects unknown, archived or other kids' goals", async () => {
    const goal = await addGoal()
    const otherKid = (await api.post("/kids").send(factories.kid())).body.id
    const otherGoal = (await api.post(`/kids/${otherKid}/goals`).send({ name: "Bike", targetAmount: 9 })).body.id
    const t = await addTask()
    expect((await api.post(`/tasks/${t.id}/submit`).send({ rewardGoalId: "nope" })).status).toBe(400)
    expect((await api.post(`/tasks/${t.id}/submit`).send({ rewardGoalId: otherGoal })).status).toBe(400)
    await api.post(`/tasks/${t.id}/submit`).send({ rewardGoalId: goal.id })
    await api.delete(`/goals/${goal.id}`)
    expect((await api.post(`/tasks/${t.id}/approve`).send({})).status).toBe(400)
    expect((await api.post(`/tasks/${t.id}/approve`).send({ rewardGoalId: null })).status).toBe(200)
  })

  it("approving a repeating task creates the next one", async () => {
    const t = await addTask({ dueDate: "2026-01-31", recurrence: "MONTHLY" })
    await api.post(`/tasks/${t.id}/approve`).send({})
    const oct = await addTask({ title: "Oct", dueDate: "2026-10-31", recurrence: "MONTHLY" })
    await api.post(`/tasks/${oct.id}/approve`).send({})
    const nov = (await api.get(`/kids/${kidId}/tasks`)).body.find((x: { title: string; status: string }) => x.title === "Oct" && x.status === "OPEN")
    expect(nov.dueDate.slice(0, 10)).toBe("2026-11-30")
    await api.delete(`/tasks/${nov.id}`)
    const w = await addTask({ dueDate: "2026-10-30", recurrence: "WEEKLY" })
    await api.post(`/tasks/${w.id}/approve`).send({})
    const open = (await api.get(`/kids/${kidId}/tasks`)).body.filter((x: { status: string }) => x.status === "OPEN")
    expect(open.map((x: { dueDate: string }) => x.dueDate.slice(0, 10)).sort()).toEqual(["2026-02-28", "2026-11-06"])
  })

  it("is isolated per family and needs auth", async () => {
    const t = await addTask()
    const other = as((await registerUser()).token)
    expect((await other.get(`/kids/${kidId}/tasks`)).status).toBe(404)
    expect((await other.post(`/kids/${kidId}/tasks`).send({ title: "x", reward: 1 })).status).toBe(404)
    for (const path of ["submit", "approve", "reject"]) {
      expect((await other.post(`/tasks/${t.id}/${path}`).send({})).status).toBe(404)
    }
    expect((await other.put(`/tasks/${t.id}`).send({ title: "x", reward: 1 })).status).toBe(404)
    expect((await other.delete(`/tasks/${t.id}`)).status).toBe(404)
    expect((await as("bad").get(`/kids/${kidId}/tasks`)).status).toBe(401)
    expect((await account()).total).toBe(0)
  })
})

describe("monthly job", () => {
  const scope = () => ({ parentId: parent.user.id })
  const backdate = (id: string, d: string) => db.kid.update({ where: { id }, data: { createdAt: new Date(d) } })

  it("clamps the earning day to short months", () => {
    expect(earningDate(31, new Date("2027-02-10T00:00:00Z")).toISOString()).toBe("2027-02-28T00:00:00.000Z")
    expect(earningDate(31, new Date("2028-02-10T00:00:00Z")).toISOString()).toBe("2028-02-29T00:00:00.000Z")
    expect(earningDate(15, new Date("2027-04-30T00:00:00Z")).toISOString()).toBe("2027-04-15T00:00:00.000Z")
  })

  it("credits and auto-splits once the earning day arrives, once per month", async () => {
    await backdate(kidId, "2030-01-01")
    const goal = await addGoal()
    await api.put(`/kids/${kidId}/allocations`).send({ rules: [{ goalId: goal.id, type: "PERCENT", value: 40 }] })
    await db.kid.update({ where: { id: kidId }, data: { earningDay: 10 } })

    expect(await runMonthlyEarnings(new Date("2030-03-09T23:00:00Z"), scope())).toBe(0)
    expect(await runMonthlyEarnings(new Date("2030-03-10T00:00:00Z"), scope())).toBe(1)
    expect(await runMonthlyEarnings(new Date("2030-03-25T00:00:00Z"), scope())).toBe(0)
    expect(await runMonthlyEarnings(new Date("2030-04-11T00:00:00Z"), scope())).toBe(1)
    const acc = await account()
    expect(acc).toMatchObject({ total: 1000, wallet: 600 })
    expect(acc.goals[0].balance).toBe(400)
    expect(acc.creditedMonths).toEqual(expect.arrayContaining(["2030-03", "2030-04"]))
    const [row] = (await api.get(`/kids/${kidId}/statement`)).body
    expect(row).toMatchObject({ type: "MONTHLY_EARNING", note: "April 2030", amount: 500 })
  })

  it("does not double-pay a month the parent already added by hand", async () => {
    await api.post(`/kids/${kidId}/earnings`).send({ kind: "MONTHLY", month: new Date().toISOString().slice(0, 7) })
    expect(await runMonthlyEarnings(new Date(), scope())).toBe(0)
    expect((await account()).total).toBe(500)
  })

  it("skips kids added after this month's earning day and kids with no Monthly Earning", async () => {
    await backdate(kidId, "2030-05-20T10:00:00Z")
    const zero = (await api.post("/kids").send(factories.kid({ monthlyEarning: 0 }))).body.id
    await backdate(zero, "2030-01-01")
    expect(await runMonthlyEarnings(new Date("2030-05-25T00:00:00Z"), scope())).toBe(0)
    expect(await runMonthlyEarnings(new Date("2030-06-01T00:00:00Z"), scope())).toBe(1)
  })
})
