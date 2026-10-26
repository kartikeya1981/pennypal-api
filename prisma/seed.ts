import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"

const db = new PrismaClient()

const DEMO_EMAIL = "demo@pennypal.app"
const DEMO_PASSWORD = "demo1234"

async function main() {
  const year = new Date().getUTCFullYear()
  await db.user.deleteMany({ where: { email: DEMO_EMAIL } })
  await db.user.create({
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
  })
  console.log(`Seeded demo account: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
