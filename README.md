# PennyPal API

REST API for [PennyPal](https://github.com/kartikeya1981/pennypal-ui), a parent-managed app that teaches kids under 18 to earn, save towards goals and spend wisely with virtual **Kid Coins**.

## Tech stack

Node.js 20+ · Express 5 · TypeScript · Prisma (SQLite locally) · Zod validation · JWT auth · bcrypt · helmet, CORS and rate limiting

## Getting started

```bash
npm install
cp .env.example .env     # set JWT_SECRET, e.g. `openssl rand -base64 32`
npm run setup            # creates the SQLite DB and seeds a demo account
npm run dev              # http://localhost:4000
```

Demo login: `demo@pennypal.app` / `demo1234` (two kids, Aarav and Meera, with goals, a split and this month's Earning).

Scripts: `npm run build` + `npm start` (production), `npm run typecheck`, `npm run db:seed` (reset demo user), `npm run db:studio`.

## Environment

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | Prisma connection string (`file:./dev.db` locally) |
| `JWT_SECRET` | Secret used to sign access tokens |
| `PORT` | Port to listen on (default `4000`) |
| `CORS_ORIGIN` | Comma-separated browser origins allowed to call the API |
| `MONTHLY_JOB` | Set to `off` to stop the automatic Monthly Earning job (on by default) |

## Authentication

Parents are the only account holders. `POST /auth/register` or `POST /auth/login` returns `{ token, user }`. Send the token as `Authorization: Bearer <token>` on every other request. Tokens expire after 30 days. Kid profiles are always scoped to the signed-in parent.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Health check |
| POST | `/auth/register` | `{ name, email, password }` |
| POST | `/auth/login` | `{ email, password }` |
| GET / PUT | `/me` | Signed-in parent (`name`) |
| GET, POST | `/kids` | List (with each kid's `balance`) / create kid profiles |
| GET, PUT, DELETE | `/kids/:id` | Read / replace / delete a kid profile |
| GET | `/kids/:id/account` | `{ total, wallet, goals[], creditedMonths, currentMonth }` |
| GET, POST | `/kids/:id/goals` | List / create goals `{ name, emoji, targetAmount }` (each with its jar `balance`) |
| PUT, DELETE | `/goals/:id` | Update a goal / remove it (its coins move back to the Wallet) |
| PUT | `/kids/:id/allocations` | Replace the monthly split `{ rules: [{ goalId, type: NONE\|PERCENT\|FIXED, value }] }` |
| GET | `/kids/:id/allocations/preview` | How the next Monthly Earning would be split |
| POST | `/kids/:id/earnings` | `{ kind: "MONTHLY", month: "2026-10" }` or `{ kind: "EXTRA", amount, note, goalId? }` |
| GET | `/kids/:id/statement` | Every transaction, newest first, with its legs and the balance after it |
| GET | `/kids/:id/tasks` | The kid's tasks, newest first |
| POST | `/kids/:id/tasks` | Add a task: `title`, `reward`, optional `dueDate` (`YYYY-MM-DD`) and `recurrence` (`NONE`/`WEEKLY`/`MONTHLY`) |
| PUT | `/tasks/:id` | Edit a task that isn't approved yet |
| DELETE | `/tasks/:id` | Remove a task (already-paid rewards stay on the statement) |
| POST | `/tasks/:id/submit` | Kid says "I did it": `{ rewardGoalId? }` (null = Wallet) |
| POST | `/tasks/:id/reject` | Send a submitted task back to the kid |
| POST | `/tasks/:id/approve` | Pay the reward as a Task Earning to the chosen Wallet/goal (`{ rewardGoalId? }` overrides) |

A kid is `{ name, avatar, birthYear, monthlyEarning, earningDay }`:

- `birthYear` must make the child under 18 (this year − 17 … this year)
- `monthlyEarning` is a whole number of Kid Coins (0 – 1,000,000) credited every month as an **Earning**
- `earningDay` is the day of the month (1–31) it is credited; short months use their last day
- `avatar` is an emoji (defaults to 🦊)

### Kid Coins ledger

Balances are never stored. Every change is an append-only `LedgerEntry` (whole, signed Kid Coins; `goalId = null` is the Wallet) and balances are sums of entries. The legs of one action share a `groupId`, which the statement shows as one row.

- **Monthly Earning** credits `monthlyEarning` to the Wallet and immediately splits it into goal jars: `FIXED` amounts first, then each `PERCENT` share of what is left (rounded down), never more than a goal still needs. The rest stays in the Wallet. Rules are checked so percentages total ≤ 100% and fixed amounts ≤ the Monthly Earning.
- A Monthly Earning can only be added once per kid per month (unique key `monthly:{kidId}:{YYYY-MM}`), even under concurrent requests.
- **Extra earnings** go to the Wallet or straight into a chosen goal.
- **Automatic Monthly Earning:** the API runs a job on start-up and every hour that credits each kid's Monthly Earning once their `earningDay` (UTC) has arrived; days 29–31 fall back to the last day of shorter months. It uses the same once-per-month key, so it never double-pays a month the parent already added by hand. Kids added after this month's earning day start next month. Set `MONTHLY_JOB=off` to disable it.
- **Tasks:** `OPEN` → kid submits (`SUBMITTED`, with their chosen destination) → parent approves (`APPROVED`, credits a `TASK_EARNING`) or sends it back (`OPEN`). Parents can also approve an open task directly. Each task pays at most once (key `task:{id}`). Approving a `WEEKLY`/`MONTHLY` task creates the next one with its due date moved on.
- A goal becomes `READY` when its jar reaches the target (and back to `ACTIVE` if the target is raised). Removing a goal moves its coins back to the Wallet and archives it so the statement stays complete.

Errors are returned as `{ "error": "message" }` with an appropriate status code.

## Tests

Integration tests use [Vitest](https://vitest.dev) and [Supertest](https://github.com/ladjs/supertest) against the real Express app and a throwaway SQLite database (`prisma/test.db`, created and deleted automatically). No `.env` or running server is needed.

```bash
npm test             # run once
npm run test:watch   # watch mode
```

CI (`.github/workflows/test.yml`) runs typecheck and tests on every push and pull request.

## Moving to PostgreSQL

Set `provider = "postgresql"` in `prisma/schema.prisma`, point `DATABASE_URL` at your database, delete `prisma/migrations`, and run `npx prisma migrate dev --name init`.
