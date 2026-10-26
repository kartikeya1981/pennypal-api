import type { User } from "@prisma/client"
import { Router } from "express"
import { z } from "zod"
import { userId } from "../auth"
import { db } from "../db"
import { HttpError } from "../errors"
import { parse, str } from "../validation"

export function publicUser({ passwordHash: _passwordHash, ...user }: User) {
  return user
}

const profileSchema = z.object({ name: str("Name") })

export const meRouter = Router()

meRouter.get("/", async (req, res) => {
  const user = await db.user.findUnique({ where: { id: userId(req) } })
  if (!user) throw new HttpError(401, "Please sign in")
  res.json(publicUser(user))
})

meRouter.put("/", async (req, res) => {
  const { name } = parse(profileSchema, req.body)
  const user = await db.user.update({ where: { id: userId(req) }, data: { name } })
  res.json(publicUser(user))
})
