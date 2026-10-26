import type { Request, RequestHandler } from "express"
import jwt from "jsonwebtoken"
import { env } from "./env"
import { HttpError } from "./errors"

const userIds = new WeakMap<Request, string>()

export function signToken(userId: string) {
  return jwt.sign({}, env.jwtSecret, { subject: userId, expiresIn: "30d" })
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined
  if (!token) throw new HttpError(401, "Please sign in")
  try {
    const payload = jwt.verify(token, env.jwtSecret)
    if (typeof payload === "string" || !payload.sub) throw new Error("Invalid token")
    userIds.set(req, payload.sub)
  } catch {
    throw new HttpError(401, "Your session has expired, please sign in again")
  }
  next()
}

export function userId(req: Request) {
  const id = userIds.get(req)
  if (!id) throw new HttpError(401, "Please sign in")
  return id
}
