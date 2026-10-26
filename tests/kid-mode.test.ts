import { beforeEach, describe, expect, it } from "vitest"
import request from "supertest"
import { app, as, registerUser, type TestUser } from "./helpers"

let parent: TestUser
let api: ReturnType<typeof as>

beforeEach(async () => {
  parent = await registerUser()
  api = as(parent.token)
})

describe("Kid Mode PIN", () => {
  it("starts without a PIN and never exposes hashes", async () => {
    const me = (await api.get("/me")).body
    expect(me.hasKidModePin).toBe(false)
    expect(me).not.toHaveProperty("passwordHash")
    expect(me).not.toHaveProperty("kidModePinHash")
    const unlock = await api.post("/me/kid-mode/unlock").send({ pin: "1234" })
    expect(unlock.status).toBe(400)
    expect(unlock.body.error).toBe("Set a Kid Mode PIN first")
  })

  it("needs the account password and a 4-digit PIN", async () => {
    for (const [body, error] of [
      [{ pin: "1234", password: "wrong-password" }, "Your password is incorrect"],
      [{ pin: "12a4", password: parent.password }, "PIN must be 4 digits"],
      [{ pin: "12345", password: parent.password }, "PIN must be 4 digits"],
      [{ pin: "1234" }, "Enter your password"],
    ] as const) {
      const res = await api.put("/me/kid-mode-pin").send(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error).toBe(error)
    }
    const res = await api.put("/me/kid-mode-pin").send({ pin: "0420", password: parent.password })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ hasKidModePin: true })
    expect(res.body).not.toHaveProperty("kidModePinHash")
  })

  it("unlocks with the right PIN only, and a PIN can be changed", async () => {
    await api.put("/me/kid-mode-pin").send({ pin: "0420", password: parent.password })
    expect((await api.post("/me/kid-mode/unlock").send({ pin: "0420" })).status).toBe(204)
    const wrong = await api.post("/me/kid-mode/unlock").send({ pin: "1111" })
    expect(wrong.status).toBe(403)
    expect(wrong.body.error).toBe("That PIN isn't right")
    await api.put("/me/kid-mode-pin").send({ pin: "9999", password: parent.password })
    expect((await api.post("/me/kid-mode/unlock").send({ pin: "0420" })).status).toBe(403)
    expect((await api.post("/me/kid-mode/unlock").send({ pin: "9999" })).status).toBe(204)
  })

  it("limits wrong PIN guesses per parent", async () => {
    await api.put("/me/kid-mode-pin").send({ pin: "0420", password: parent.password })
    for (let i = 0; i < 10; i++) expect((await api.post("/me/kid-mode/unlock").send({ pin: "0000" })).status).toBe(403)
    const limited = await api.post("/me/kid-mode/unlock").send({ pin: "0420" })
    expect(limited.status).toBe(429)
    expect(limited.body.error).toMatch(/Too many wrong PINs/)
    // Another parent is not affected
    const other = await registerUser()
    await as(other.token).put("/me/kid-mode-pin").send({ pin: "1234", password: other.password })
    expect((await as(other.token).post("/me/kid-mode/unlock").send({ pin: "1234" })).status).toBe(204)
  })

  it("requires sign-in", async () => {
    expect((await request(app).post("/me/kid-mode/unlock").send({ pin: "1234" })).status).toBe(401)
  })
})
