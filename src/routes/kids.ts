import { Router } from "express"
import { z } from "zod"
import { userId } from "../auth"
import { db } from "../db"
import { HttpError } from "../errors"
import { int, parse, str } from "../validation"

/** PennyPal is for children under 18: birth years from (this year - 17) up to this year. */
export function birthYearRange(now = new Date()) {
  const year = now.getUTCFullYear()
  return { min: year - 17, max: year }
}

export const MAX_MONTHLY_EARNING = 1_000_000

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" })
const graphemes = (v: string) => [...segmenter.segment(v)].length

/** Optional single emoji (one grapheme cluster, so 👩🏽‍🚀 counts as one). */
export const emoji = (message: string, fallback?: string) =>
  z.preprocess(
    (v) => (v === "" || v == null ? fallback : v),
    z
      .string()
      .trim()
      .refine((v) => v.length <= 16 && graphemes(v) === 1, message)
      .optional()
  )

function kidSchema() {
  const { min, max } = birthYearRange()
  return z.object({
    name: str("Name", 40),
    avatar: emoji("Avatar must be a single emoji"),
    birthYear: z.preprocess(
      (v) => (v === "" || v == null ? undefined : Number(v)),
      z
        .number({ message: "Birth year is required" })
        .int("Birth year must be a whole number")
        .min(min, "PennyPal is for kids under 18")
        .max(max, "Birth year cannot be in the future")
    ),
    monthlyEarning: int("Monthly earning", { max: MAX_MONTHLY_EARNING }),
    earningDay: int("Earning day", { min: 1, max: 31 }),
  })
}

export const kidsRouter = Router()

kidsRouter.get("/", async (req, res) => {
  const kids = await db.kid.findMany({ where: { parentId: userId(req) }, orderBy: { createdAt: "asc" } })
  const sums = await db.ledgerEntry.groupBy({
    by: ["kidId"],
    where: { kidId: { in: kids.map((k) => k.id) } },
    _sum: { amount: true },
  })
  const balance = new Map(sums.map((s) => [s.kidId, s._sum.amount ?? 0]))
  res.json(kids.map((k) => ({ ...k, balance: balance.get(k.id) ?? 0 })))
})

kidsRouter.get("/:id", async (req, res) => {
  const kid = await db.kid.findFirst({ where: { id: req.params.id, parentId: userId(req) } })
  if (!kid) throw new HttpError(404, "Not found")
  res.json(kid)
})

kidsRouter.post("/", async (req, res) => {
  const data = parse(kidSchema(), req.body)
  res.status(201).json(await db.kid.create({ data: { ...data, parentId: userId(req) } }))
})

kidsRouter.put("/:id", async (req, res) => {
  const data = parse(kidSchema(), req.body)
  const where = { id: req.params.id, parentId: userId(req) }
  const { count } = await db.kid.updateMany({ where, data })
  if (!count) throw new HttpError(404, "Not found")
  res.json(await db.kid.findFirst({ where }))
})

kidsRouter.delete("/:id", async (req, res) => {
  const { count } = await db.kid.deleteMany({ where: { id: req.params.id, parentId: userId(req) } })
  if (!count) throw new HttpError(404, "Not found")
  res.status(204).end()
})
