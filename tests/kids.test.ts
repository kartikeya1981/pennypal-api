import { beforeAll, describe, expect, it } from "vitest"
import { as, factories, registerUser, thisYear, type TestUser } from "./helpers"

describe("/kids", () => {
  let parent: TestUser
  beforeAll(async () => {
    parent = await registerUser()
  })

  it("creates kid profiles and lists them oldest first", async () => {
    const { token } = await registerUser()
    const a = await as(token).post("/kids").send(factories.kid({ name: "  Aarav " }))
    expect(a.status).toBe(201)
    expect(a.body).toMatchObject({ name: "Aarav", avatar: "🦁", monthlyEarning: 500, earningDay: 1 })
    const b = await as(token).post("/kids").send(factories.kid({ name: "Meera", avatar: "🦄" }))
    expect(b.status).toBe(201)
    const list = await as(token).get("/kids")
    expect(list.status).toBe(200)
    expect(list.body.map((k: { name: string }) => k.name)).toEqual(["Aarav", "Meera"])
  })

  it("coerces numeric strings from HTML forms and defaults the avatar", async () => {
    const res = await as(parent.token)
      .post("/kids")
      .send({ name: "Kabir", avatar: "", birthYear: String(thisYear() - 5), monthlyEarning: "250", earningDay: "15" })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ avatar: "🦊", birthYear: thisYear() - 5, monthlyEarning: 250, earningDay: 15 })
  })

  it("reads, updates and deletes a kid", async () => {
    const { id } = (await as(parent.token).post("/kids").send(factories.kid())).body
    expect((await as(parent.token).get(`/kids/${id}`)).body.name).toBe("Aarav")

    const updated = await as(parent.token).put(`/kids/${id}`).send(factories.kid({ name: "Aarav R", monthlyEarning: 750, earningDay: 31 }))
    expect(updated.status).toBe(200)
    expect(updated.body).toMatchObject({ name: "Aarav R", monthlyEarning: 750, earningDay: 31 })

    expect((await as(parent.token).delete(`/kids/${id}`)).status).toBe(204)
    expect((await as(parent.token).get(`/kids/${id}`)).status).toBe(404)
  })

  it("accepts multi-codepoint emoji avatars", async () => {
    const res = await as(parent.token).post("/kids").send(factories.kid({ avatar: "👩🏽‍🚀" }))
    expect(res.status).toBe(201)
    expect(res.body.avatar).toBe("👩🏽‍🚀")
  })

  it("accepts kids from newborn up to 17 years old", async () => {
    for (const birthYear of [thisYear(), thisYear() - 17]) {
      const res = await as(parent.token).post("/kids").send(factories.kid({ birthYear }))
      expect(res.status).toBe(201)
    }
  })

  it.each([
    [{ name: "" }, "Name is required"],
    [{ name: "x".repeat(41) }, "Name must be at most 40 characters"],
    [{ birthYear: "" }, "Birth year is required"],
    [{ birthYear: thisYear() - 18 }, "PennyPal is for kids under 18"],
    [{ birthYear: thisYear() + 1 }, "Birth year cannot be in the future"],
    [{ birthYear: 2015.5 }, "Birth year must be a whole number"],
    [{ monthlyEarning: -1 }, "Monthly earning cannot be negative"],
    [{ monthlyEarning: 10.5 }, "Monthly earning must be a whole number"],
    [{ monthlyEarning: "abc" }, "Monthly earning must be a number"],
    [{ monthlyEarning: 1_000_001 }, "Monthly earning must be at most 1000000"],
    [{ earningDay: 0 }, "Earning day must be at least 1"],
    [{ earningDay: 32 }, "Earning day must be at most 31"],
    [{ avatar: "🦁".repeat(9) }, "Avatar must be a single emoji"],
    [{ avatar: "🦁🦄" }, "Avatar must be a single emoji"],
  ])("rejects invalid kid %j", async (override, error) => {
    const res = await as(parent.token).post("/kids").send(factories.kid(override))
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error })
  })

  it("returns 404 for unknown kids", async () => {
    expect((await as(parent.token).get("/kids/nope")).status).toBe(404)
    expect((await as(parent.token).put("/kids/nope").send(factories.kid())).status).toBe(404)
    expect((await as(parent.token).delete("/kids/nope")).status).toBe(404)
  })
})

describe("kid profile isolation between parents", () => {
  it("never exposes or lets another parent change a kid", async () => {
    const alice = await registerUser({ name: "Alice" })
    const bob = await registerUser({ name: "Bob" })
    const { id } = (await as(alice.token).post("/kids").send(factories.kid())).body

    expect((await as(bob.token).get("/kids")).body).toEqual([])
    expect((await as(bob.token).get(`/kids/${id}`)).status).toBe(404)
    expect((await as(bob.token).put(`/kids/${id}`).send(factories.kid({ name: "Hacked" }))).status).toBe(404)
    expect((await as(bob.token).delete(`/kids/${id}`)).status).toBe(404)

    const still = await as(alice.token).get(`/kids/${id}`)
    expect(still.status).toBe(200)
    expect(still.body.name).toBe("Aarav")
  })

  it("ignores a parentId sent in the body", async () => {
    const alice = await registerUser()
    const bob = await registerUser()
    const res = await as(bob.token).post("/kids").send({ ...factories.kid(), parentId: alice.user.id })
    expect(res.status).toBe(201)
    expect(res.body.parentId).toBe(bob.user.id)
    expect((await as(alice.token).get("/kids")).body).toEqual([])
  })
})
