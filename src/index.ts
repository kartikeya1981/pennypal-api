import { createApp } from "./app"
import { env } from "./env"
import { startMonthlyScheduler } from "./jobs/monthly"

createApp().listen(env.port, () => {
  console.log(`PennyPal API listening on http://localhost:${env.port}`)
})

if (env.monthlyJob) startMonthlyScheduler()
