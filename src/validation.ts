import { z } from "zod"
import { HttpError } from "./errors"

const isEmpty = (v: unknown) => v === "" || v === null || v === undefined

/** Whole number field (Kid Coins, days, years). Strings from HTML forms are coerced. */
export const int = (label: string, { min = 0, max }: { min?: number; max?: number } = {}) =>
  z.preprocess(
    (v) => (isEmpty(v) ? undefined : Number(v)),
    z
      .number({ message: `${label} must be a number` })
      .int(`${label} must be a whole number`)
      .min(min, min === 0 ? `${label} cannot be negative` : `${label} must be at least ${min}`)
      .max(max ?? Number.MAX_SAFE_INTEGER, `${label} must be at most ${max}`)
  )

export const str = (label: string, max = 100) =>
  z
    .string({ message: `${label} is required` })
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be at most ${max} characters`)

export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input ?? {})
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message ?? "Invalid input")
  return result.data
}
