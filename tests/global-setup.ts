import { execSync } from "node:child_process"
import { rmSync } from "node:fs"
import path from "node:path"

const root = process.cwd()
const dbFiles = ["prisma/test.db", "prisma/test.db-journal"]

function removeDb() {
  for (const f of dbFiles) rmSync(path.join(root, f), { force: true })
}

export default function setup() {
  removeDb()
  execSync("npx prisma migrate deploy", {
    cwd: root,
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: "file:./test.db" },
  })
  return removeDb
}
