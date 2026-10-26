import { randomUUID } from "node:crypto"
import request from "supertest"
import { createApp } from "../src/app"

export const app = createApp()

let ipCounter = 0

/**
 * /auth is rate limited per client IP. The app trusts one proxy hop, so give every
 * test request its own X-Forwarded-For to keep suites independent of the limiter.
 */
export function uniqueIp() {
  ipCounter += 1
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`
}

export function uniqueEmail(prefix = "user") {
  return `${prefix}-${randomUUID()}@test.pennypal.app`
}

export type TestUser = {
  token: string
  user: { id: string; name: string; email: string }
  password: string
}

export async function registerUser(overrides: Partial<{ name: string; email: string; password: string }> = {}) {
  const body = { name: "Test Parent", email: uniqueEmail(), password: "password123", ...overrides }
  const res = await request(app).post("/auth/register").set("X-Forwarded-For", uniqueIp()).send(body)
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`)
  return { token: res.body.token, user: res.body.user, password: body.password } as TestUser
}

/** Supertest wrapper that sends the bearer token on every request. */
export function as(token: string) {
  const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`)
  const agent = request(app)
  return {
    get: (url: string) => auth(agent.get(url)),
    post: (url: string) => auth(agent.post(url)),
    put: (url: string) => auth(agent.put(url)),
    delete: (url: string) => auth(agent.delete(url)),
  }
}

export const thisYear = () => new Date().getUTCFullYear()

export const factories = {
  kid: (o: Record<string, unknown> = {}) => ({
    name: "Aarav",
    avatar: "🦁",
    birthYear: thisYear() - 10,
    monthlyEarning: 500,
    earningDay: 1,
    ...o,
  }),
}
