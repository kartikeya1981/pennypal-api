import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"
import { credit } from "../src/ledger"

const db = new PrismaClient()

const DEMO_EMAIL = "demo@pennypal.app"
const DEMO_PASSWORD = "demo1234"

async function main() {
  const year = new Date().getUTCFullYear()
  await db.user.deleteMany({ where: { email: DEMO_EMAIL } })
  const parent = await db.user.create({
    data: {
      name: "Demo Parent",
      email: DEMO_EMAIL,
      passwordHash: await bcrypt.hash(DEMO_PASSWORD, 10),
      kids: {
        create: [
          { name: "Aarav", avatar: "🦁", birthYear: year - 12, monthlyEarning: 500, earningDay: 1 },
          { name: "Meera", avatar: "🦄", birthYear: year - 9, monthlyEarning: 300, earningDay: 1 },
        ],
      },
    },
    include: { kids: true },
  })
  const [aarav, meera] = parent.kids
  await db.goal.createMany({
    data: [
      { kidId: aarav.id, name: "Video game", emoji: "🎮", targetAmount: 3000, allocationType: "FIXED", allocationValue: 200 },
      { kidId: aarav.id, name: "Tennis racket", emoji: "🎾", targetAmount: 2500, allocationType: "PERCENT", allocationValue: 50 },
      { kidId: meera.id, name: "Sparkly sneakers", emoji: "👟", targetAmount: 1500, allocationType: "PERCENT", allocationValue: 60 },
    ],
  })
  const month = new Date().toISOString().slice(0, 7)
  for (const kid of [aarav, meera]) {
    await credit({
      kidId: kid.id,
      createdById: parent.id,
      amount: kid.monthlyEarning,
      type: "MONTHLY_EARNING",
      note: new Date().toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
      autoAllocate: true,
      idempotencyKey: `monthly:${kid.id}:${month}`,
    })
  }
  await credit({ kidId: aarav.id, createdById: parent.id, amount: 100, type: "EXTRA_EARNING", note: "Finished reading a book" })
  console.log(`Seeded demo account: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
