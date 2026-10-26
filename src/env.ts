import "dotenv/config"

function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: required("JWT_SECRET"),
  corsOrigins: (process.env.CORS_ORIGIN ?? "http://localhost:3000").split(",").map((o) => o.trim()),
  isProd: process.env.NODE_ENV === "production",
  /** Credit Monthly Earnings automatically (set MONTHLY_JOB=off to disable, e.g. in E2E runs). */
  monthlyJob: process.env.MONTHLY_JOB !== "off",
}
