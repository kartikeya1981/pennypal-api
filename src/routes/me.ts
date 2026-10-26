import type { User } from "@prisma/client"
import bcrypt from "bcryptjs"
import { Router } from "express"
import rateLimit from "express-rate-limit"
import { z } from "zod"
import { userId } from "../auth"
import { db } from "../db"
import { HttpError } from "../errors"
import { parse, str } from "../validation"

export function publicUser({ passwordHash: _passwordHash, kidModePinHash, ...user }: User) {
  return { ...user, hasKidModePin: kidModePinHash !== null }
}

const profileSchema = z.object({ name: str("Name") })

const pin = z.string({ message: "PIN is required" }).regex(/^\d{4}$/, "PIN must be 4 digits")
const pinSchema = z.object({ pin, password: z.string({ message: "Enter your password" }).min(1, "Enter your password") })

async function currentUser(id: string) {
  const user = await db.user.findUnique({ where: { id } })
  if (!user) throw new HttpError(401, "Please sign in")
  return user
}

export const meRouter = Router()

meRouter.get("/", async (req, res) => {
  res.json(publicUser(await currentUser(userId(req))))
})

meRouter.put("/", async (req, res) => {
  const { name } = parse(profileSchema, req.body)
  const user = await db.user.update({ where: { id: userId(req) }, data: { name } })
  res.json(publicUser(user))
})

/** Sets or changes the Kid Mode PIN. Needs the account password, so a kid can't change it. */
meRouter.put("/kid-mode-pin", async (req, res) => {
  const data = parse(pinSchema, req.body)
  const user = await currentUser(userId(req))
  // 400 rather than 401: the UI treats 401 as an expired session
  if (!(await bcrypt.compare(data.password, user.passwordHash))) throw new HttpError(400, "Your password is incorrect")
  const updated = await db.user.update({ where: { id: user.id }, data: { kidModePinHash: await bcrypt.hash(data.pin, 10) } })
  res.json(publicUser(updated))
})

const unlockLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => userId(req),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many wrong PINs. Wait 15 minutes, or sign out and sign in again." },
})

/** Checks the PIN that leaves Kid Mode. */
meRouter.post("/kid-mode/unlock", unlockLimiter, async (req, res) => {
  const data = parse(z.object({ pin }), req.body)
  const user = await currentUser(userId(req))
  if (!user.kidModePinHash) throw new HttpError(400, "Set a Kid Mode PIN first")
  if (!(await bcrypt.compare(data.pin, user.kidModePinHash))) throw new HttpError(403, "That PIN isn't right")
  res.status(204).end()
})
