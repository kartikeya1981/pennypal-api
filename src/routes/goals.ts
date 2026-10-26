import { Router, type Request } from "express"
import { userId } from "../auth"
import { db } from "../db"
import { HttpError } from "../errors"
import { archiveGoal, balances, refreshGoalStatuses } from "../ledger"
import { parse } from "../validation"
import { goalSchema } from "./account"

async function ownedGoal(req: Request) {
  const goal = await db.goal.findFirst({
    where: { id: req.params.id as string, status: { not: "ARCHIVED" }, kid: { parentId: userId(req) } },
  })
  if (!goal) throw new HttpError(404, "Not found")
  return goal
}

export const goalsRouter = Router()

goalsRouter.put("/:id", async (req, res) => {
  const goal = await ownedGoal(req)
  const data = parse(goalSchema, req.body)
  const updated = await db.$transaction(async (tx) => {
    await tx.goal.update({ where: { id: goal.id }, data })
    await refreshGoalStatuses(tx, goal.kidId)
    return tx.goal.findUniqueOrThrow({ where: { id: goal.id } })
  })
  const { byGoal } = await balances(db, goal.kidId)
  res.json({ ...updated, balance: byGoal.get(goal.id) ?? 0 })
})

goalsRouter.delete("/:id", async (req, res) => {
  const goal = await ownedGoal(req)
  await archiveGoal(goal, userId(req))
  res.status(204).end()
})
