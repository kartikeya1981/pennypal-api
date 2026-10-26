import jwt from "jsonwebtoken"
import request from "supertest"
import { describe, expect, it } from "vitest"
import { app, as, registerUser, uniqueEmail, uniqueIp } from "./helpers"

const post = (path: string, body: unknown) => request(app).post(path).set("X-Forwarded-For", uniqueIp()).send(body as object)

describe("POST /auth/register", () => {
  it("creates an account and returns a token and public user", async () => {
    const email = uniqueEmail("reg")
    const res = await post("/auth/register", { name: "  Asha Rao ", email: email.toUpperCase(), password: "password123" })
    expect(res.status).toBe(201)
    expect(res.body.token).toEqual(expect.any(String))
    expect(res.body.user).toMatchObject({ name: "Asha Rao", email })
    expect(res.body.user).not.toHaveProperty("passwordHash")
  })

  it("issues a JWT for the new user that expires in 30 days", async () => {
    const { token, user } = await registerUser()
    const payload = jwt.decode(token) as jwt.JwtPayload
    expect(payload.sub).toBe(user.id)
    expect(payload.exp! - payload.iat!).toBe(30 * 24 * 60 * 60)
  })

  it("rejects a duplicate email (case-insensitive)", async () => {
    const { user } = await registerUser()
    const res = await post("/auth/register", { name: "Dup", email: user.email.toUpperCase(), password: "password123" })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: "An account with this email already exists" })
  })

  it.each([
    [{ name: "A", email: uniqueEmail(), password: "password123" }, "Please enter your name"],
    [{ name: "Asha", email: "not-an-email", password: "password123" }, "Enter a valid email"],
    [{ name: "Asha", email: uniqueEmail(), password: "short" }, "Password must be at least 8 characters"],
  ])("rejects invalid input %j", async (body, error) => {
    const res = await post("/auth/register", body)
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error })
  })

  // Missing (as opposed to empty) fields currently surface Zod's default message.
  it.each([{ email: uniqueEmail(), password: "password123" }, {}])("rejects missing fields %j", async (body) => {
    const res = await post("/auth/register", body)
    expect(res.status).toBe(400)
    expect(res.body.error).toEqual(expect.any(String))
  })
})

describe("POST /auth/login", () => {
  it("logs in with valid credentials (email is trimmed and case-insensitive)", async () => {
    const { user, password } = await registerUser()
    const res = await post("/auth/login", { email: `  ${user.email.toUpperCase()} `, password })
    expect(res.status).toBe(200)
    expect(res.body.user).toMatchObject({ id: user.id, email: user.email })
    expect(res.body.user).not.toHaveProperty("passwordHash")
    const me = await as(res.body.token).get("/me")
    expect(me.status).toBe(200)
  })

  it("rejects a wrong password", async () => {
    const { user } = await registerUser()
    const res = await post("/auth/login", { email: user.email, password: "wrong-password" })
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: "Invalid email or password" })
  })

  it("rejects an unknown email with the same message", async () => {
    const res = await post("/auth/login", { email: uniqueEmail("ghost"), password: "password123" })
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: "Invalid email or password" })
  })

  it.each([
    [{ email: "bad", password: "x" }, "Enter a valid email"],
    [{ email: "a@b.co", password: "" }, "Password is required"],
  ])("validates %j", async (body, error) => {
    const res = await post("/auth/login", body)
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error })
  })
})

describe("auth rate limiting", () => {
  it("returns 429 after 50 auth requests from one IP in the window", async () => {
    const ip = uniqueIp()
    const body = { email: uniqueEmail("rl"), password: "password123" }
    for (let i = 0; i < 50; i++) {
      const res = await request(app).post("/auth/login").set("X-Forwarded-For", ip).send(body)
      expect(res.status).toBe(401)
    }
    const limited = await request(app).post("/auth/login").set("X-Forwarded-For", ip).send(body)
    expect(limited.status).toBe(429)
    expect(limited.headers["ratelimit-policy"]).toBeDefined()
  })
})

describe("protected routes", () => {
  const protectedPaths = ["/me", "/kids"]
  const secret = "test-secret-do-not-use-in-production"

  it.each(protectedPaths)("GET %s requires a token", async (path) => {
    const res = await request(app).get(path)
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: "Please sign in" })
  })

  it.each(protectedPaths)("GET %s rejects a non-Bearer authorization header", async (path) => {
    const res = await request(app).get(path).set("Authorization", "Basic abc")
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: "Please sign in" })
  })

  it("rejects a malformed token", async () => {
    const res = await as("not-a-jwt").get("/me")
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: "Your session has expired, please sign in again" })
  })

  it("rejects a token signed with another secret", async () => {
    const { user } = await registerUser()
    const res = await as(jwt.sign({}, "some-other-secret", { subject: user.id })).get("/me")
    expect(res.status).toBe(401)
  })

  it("rejects an expired token", async () => {
    const { user } = await registerUser()
    const expired = jwt.sign({ exp: Math.floor(Date.now() / 1000) - 60 }, secret, { subject: user.id })
    const res = await as(expired).get("/me")
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: "Your session has expired, please sign in again" })
  })

  it("rejects a token without a subject", async () => {
    const res = await as(jwt.sign({}, secret)).get("/me")
    expect(res.status).toBe(401)
  })

  it("rejects a valid token for a user that no longer exists on /me", async () => {
    const res = await as(jwt.sign({}, secret, { subject: "deleted-user-id" })).get("/me")
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: "Please sign in" })
  })
})
