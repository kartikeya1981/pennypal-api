import { describe, expect, it } from "vitest"
import { allocate } from "../src/ledger"

const g = (id: string, allocationType: string, allocationValue: number, remaining = 1_000_000) => ({
  id,
  allocationType,
  allocationValue,
  remaining,
})

describe("allocate", () => {
  it("takes fixed amounts first, then percentages of what is left", () => {
    expect(allocate(500, [g("a", "PERCENT", 50), g("b", "FIXED", 100)])).toEqual({
      shares: [
        { goalId: "b", amount: 100 },
        { goalId: "a", amount: 200 },
      ],
      wallet: 200,
    })
  })

  it("rounds percentages down and leaves the remainder in the Wallet", () => {
    expect(allocate(99, [g("a", "PERCENT", 33), g("b", "PERCENT", 33)])).toEqual({
      shares: [
        { goalId: "a", amount: 32 },
        { goalId: "b", amount: 32 },
      ],
      wallet: 35,
    })
  })

  it("never gives a goal more than it still needs", () => {
    expect(allocate(500, [g("a", "FIXED", 300, 120), g("b", "PERCENT", 100, 50)])).toEqual({
      shares: [
        { goalId: "a", amount: 120 },
        { goalId: "b", amount: 50 },
      ],
      wallet: 330,
    })
  })

  it("stops when the money runs out", () => {
    expect(allocate(150, [g("a", "FIXED", 100), g("b", "FIXED", 100)]).shares).toEqual([
      { goalId: "a", amount: 100 },
      { goalId: "b", amount: 50 },
    ])
  })

  it("ignores goals with no rule or already reached", () => {
    expect(allocate(100, [g("a", "NONE", 0), g("b", "FIXED", 10, 0)])).toEqual({ shares: [], wallet: 100 })
  })
})
