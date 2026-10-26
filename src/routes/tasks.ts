import { Router, type Request } from "express"
import { z } from "zod"
import { userId } from "../auth"
import { db } from "../db"
import { HttpError } from "../errors"
import { credit, serialize } from "../ledger"
import { int, parse, str } from "../validation"
import { ownedKid } from "./account"

export const MAX_TASK_REWARD = 100_000

const taskSchema = z.object({
  title: str("Task", 60),
  reward: int("Reward", { min: 1, max: MAX_TASK_REWARD }),
  dueDate: z.preprocess(
    (v) => (v === "" || v == null ? null : v),
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Due date must look like 2026-10-31")
      .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "Due date is not a real date")
      .transform((v) => new Date(`${v}T00:00:00Z`))
      .nullable()
  ),
  recurrence: z.preprocess(
    (v) => (v === "" || v == null ? "NONE" : v),
    z.enum(["NONE", "WEEKLY", "MONTHLY"], { message: "Repeat must be Never, Weekly or Monthly" })
  ),
})

const destinationSchema = z.object({
  rewardGoalId: z.preprocess((v) => (v === "" ? null : v), z.string().nullish()),
})

async function ownedTask(req: Request) {
  const task = await db.task.findFirst({ where: { id: req.params.id as string, kid: { parentId: userId(req) } } })
  if (!task) throw new HttpError(404, "Not found")
  return task
}

/** null = Wallet; otherwise the goal must be one of this kid's current goals. */
async function checkGoal(kidId: string, goalId: string | null | undefined) {
  if (!goalId) return null
  const goal = await db.goal.findFirst({ where: { id: goalId, kidId, status: { in: ["ACTIVE", "READY"] } } })
  if (!goal) throw new HttpError(400, "Unknown goal")
  return goal.id
}

function nextDue(due: Date | null, recurrence: string) {
  if (!due) return null
  const d = new Date(due)
  if (recurrence === "WEEKLY") {
    d.setUTCDate(d.getUTCDate() + 7)
    return d
  }
  // Same day next month; 29–31 fall back to the last day of a shorter month (31 Oct -> 30 Nov)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + 1
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), new Date(Date.UTC(y, m + 1, 0)).getUTCDate())))
}

/** Mounted under /kids */
export const kidTasksRouter = Router()

kidTasksRouter.get("/:id/tasks", async (req, res) => {
  const kid = await ownedKid(req, req.params.id as string)
  res.json(await db.task.findMany({ where: { kidId: kid.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }))
})

kidTasksRouter.post("/:id/tasks", async (req, res) => {
  const kid = await ownedKid(req, req.params.id as string)
  const data = parse(taskSchema, req.body)
  res.status(201).json(await db.task.create({ data: { ...data, kidId: kid.id } }))
})

/** Mounted under /tasks */
export const tasksRouter = Router()

tasksRouter.put("/:id", async (req, res) => {
  const task = await ownedTask(req)
  if (task.status === "APPROVED") throw new HttpError(400, "Approved tasks can't be changed")
  const data = parse(taskSchema, req.body)
  res.json(await db.task.update({ where: { id: task.id }, data }))
})

tasksRouter.delete("/:id", async (req, res) => {
  const task = await ownedTask(req)
  await db.task.delete({ where: { id: task.id } })
  res.status(204).end()
})

/** The kid says "I did it" and picks where the reward should go. */
tasksRouter.post("/:id/submit", async (req, res) => {
  const task = await ownedTask(req)
  if (task.status !== "OPEN") throw new HttpError(400, "Only open tasks can be marked as done")
  const rewardGoalId = await checkGoal(task.kidId, parse(destinationSchema, req.body).rewardGoalId)
  const { count } = await db.task.updateMany({
    where: { id: task.id, status: "OPEN" },
    data: { status: "SUBMITTED", rewardGoalId, submittedAt: new Date() },
  })
  if (!count) throw new HttpError(409, "This task was just updated, please refresh")
  res.json(await db.task.findUniqueOrThrow({ where: { id: task.id } }))
})

/** Sends a submitted task back to the kid. */
tasksRouter.post("/:id/reject", async (req, res) => {
  const task = await ownedTask(req)
  if (task.status !== "SUBMITTED") throw new HttpError(400, "Only tasks marked as done can be sent back")
  res.json(await db.task.update({ where: { id: task.id }, data: { status: "OPEN", rewardGoalId: null, submittedAt: null } }))
})

/**
 * Approves an open or submitted task and credits the reward as a Task Earning, to the destination
 * the kid chose (or one given here). The `task:{id}` key means a task can only ever pay once.
 */
tasksRouter.post("/:id/approve", async (req, res) => {
  const task = await ownedTask(req)
  if (task.status === "APPROVED") throw new HttpError(409, "This task was already approved")
  const body = parse(destinationSchema, req.body)
  const goalId = await checkGoal(task.kidId, body.rewardGoalId !== undefined ? body.rewardGoalId : task.rewardGoalId)
  // Claim the task first so concurrent approvals can't race each other into the ledger.
  await serialize(async () => {
    const { count } = await db.task.updateMany({
      where: { id: task.id, status: { in: ["OPEN", "SUBMITTED"] } },
      data: { status: "APPROVED", rewardGoalId: goalId, approvedAt: new Date() },
    })
    if (!count) throw new HttpError(409, "This task was already approved")
    try {
      await credit({
        kidId: task.kidId,
        createdById: userId(req),
        amount: task.reward,
        type: "TASK_EARNING",
        note: task.title,
        goalId,
        idempotencyKey: `task:${task.id}`,
      })
    } catch (e) {
      await db.task.update({
        where: { id: task.id },
        data: { status: task.status, rewardGoalId: task.rewardGoalId, approvedAt: null },
      })
      if (e instanceof HttpError && e.status === 409) throw new HttpError(409, "This task was already approved")
      throw e
    }
  })
  const approved = await db.task.findUniqueOrThrow({ where: { id: task.id } })
  if (task.recurrence !== "NONE") {
    await db.task.create({
      data: {
        kidId: task.kidId,
        title: task.title,
        reward: task.reward,
        recurrence: task.recurrence,
        dueDate: nextDue(task.dueDate, task.recurrence),
      },
    })
  }
  res.json(approved)
})
