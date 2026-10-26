import request from "supertest"
import { describe, expect, it } from "vitest"
import { app } from "./helpers"

describe("GET /health", () => {
  it("returns ok without authentication", async () => {
    const res = await request(app).get("/health")
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it("sets security headers and hides the framework", async () => {
    const res = await request(app).get("/health")
    expect(res.headers["x-powered-by"]).toBeUndefined()
    expect(res.headers["x-content-type-options"]).toBe("nosniff")
    expect(res.headers["content-security-policy"]).toBeDefined()
  })
})

describe("CORS", () => {
  it("allows the configured origin", async () => {
    const res = await request(app).get("/health").set("Origin", "http://localhost:3000")
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000")
  })

  it("does not allow other origins", async () => {
    const res = await request(app).get("/health").set("Origin", "https://evil.example.com")
    expect(res.headers["access-control-allow-origin"]).toBeUndefined()
  })
})

describe("unknown routes and bad input", () => {
  it("returns 404 JSON for unknown routes", async () => {
    const res = await request(app).get("/does-not-exist")
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: "Not found" })
  })

  it("returns 400 for malformed JSON", async () => {
    const res = await request(app)
      .post("/auth/login")
      .set("Content-Type", "application/json")
      .send('{"email": "broken"')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "Invalid JSON body" })
  })

  it("rejects bodies larger than 100kb with 413", async () => {
    const res = await request(app)
      .post("/auth/login")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ email: "a@b.co", password: "x".repeat(150_000) }))
    expect(res.status).toBe(413)
    expect(res.body).toEqual({ error: "Request body is too large" })
  })
})
