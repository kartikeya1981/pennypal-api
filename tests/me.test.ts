import { describe, expect, it } from "vitest"
import { as, registerUser } from "./helpers"

describe("/me", () => {
  it("returns the signed-in parent without the password hash", async () => {
    const { token, user } = await registerUser({ name: "Priya" })
    const res = await as(token).get("/me")
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: user.id, name: "Priya", email: user.email })
    expect(res.body).not.toHaveProperty("passwordHash")
  })

  it("updates the parent's name", async () => {
    const { token } = await registerUser()
    const res = await as(token).put("/me").send({ name: "  Rahul  " })
    expect(res.status).toBe(200)
    expect(res.body.name).toBe("Rahul")
    expect((await as(token).get("/me")).body.name).toBe("Rahul")
  })

  it("rejects an empty name", async () => {
    const { token } = await registerUser()
    const res = await as(token).put("/me").send({ name: " " })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "Name is required" })
  })
})
