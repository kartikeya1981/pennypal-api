import bcrypt from "bcryptjs"
import { Router } from "express"
import rateLimit from "express-rate-limit"
import { z } from "zod"
import { signToken } from "../auth"
import { db } from "../db"
import { HttpError } from "../errors"
import { parse } from "../validation"
import { publicUser } from "./me"

export const authRouter = Router()

authRouter.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: "draft-8", legacyHeaders: false }))

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
})

const registerSchema = z.object({
  name: z.string().trim().min(2, "Please enter your name"),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
})

authRouter.post("/login", async (req, res) => {
  const { email, password } = parse(loginSchema, req.body)
  const user = await db.user.findUnique({ where: { email } })
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new HttpError(401, "Invalid email or password")
  }
  res.json({ token: signToken(user.id), user: publicUser(user) })
})

authRouter.post("/register", async (req, res) => {
  const { name, email, password } = parse(registerSchema, req.body)
  if (await db.user.findUnique({ where: { email } })) {
    throw new HttpError(409, "An account with this email already exists")
  }
  const user = await db.user.create({ data: { name, email, passwordHash: await bcrypt.hash(password, 10) } })
  res.status(201).json({ token: signToken(user.id), user: publicUser(user) })
})
