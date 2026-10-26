import cors from "cors"
import express from "express"
import helmet from "helmet"
import { requireAuth } from "./auth"
import { env } from "./env"
import { errorHandler, HttpError } from "./errors"
import { authRouter } from "./routes/auth"
import { kidsRouter } from "./routes/kids"
import { meRouter } from "./routes/me"

export function createApp() {
  const app = express()
  app.disable("x-powered-by")
  app.set("trust proxy", 1)
  app.use(helmet())
  app.use(cors({ origin: env.corsOrigins }))
  app.use(express.json({ limit: "100kb" }))

  app.get("/health", (_req, res) => {
    res.json({ ok: true })
  })
  app.use("/auth", authRouter)
  app.use("/me", requireAuth, meRouter)
  app.use("/kids", requireAuth, kidsRouter)

  app.use(() => {
    throw new HttpError(404, "Not found")
  })
  app.use(errorHandler)
  return app
}
