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

Demo login: `demo@pennypal.app` / `demo1234` (two kids: Aarav and Meera).

Scripts: `npm run build` + `npm start` (production), `npm run typecheck`, `npm run db:seed` (reset demo user), `npm run db:studio`.

## Environment

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | Prisma connection string (`file:./dev.db` locally) |
| `JWT_SECRET` | Secret used to sign access tokens |
| `PORT` | Port to listen on (default `4000`) |
| `CORS_ORIGIN` | Comma-separated browser origins allowed to call the API |

## Authentication

Parents are the only account holders. `POST /auth/register` or `POST /auth/login` returns `{ token, user }`. Send the token as `Authorization: Bearer <token>` on every other request. Tokens expire after 30 days. Kid profiles are always scoped to the signed-in parent.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Health check |
| POST | `/auth/register` | `{ name, email, password }` |
| POST | `/auth/login` | `{ email, password }` |
| GET / PUT | `/me` | Signed-in parent (`name`) |
| GET, POST | `/kids` | List / create kid profiles |
| GET, PUT, DELETE | `/kids/:id` | Read / replace / delete a kid profile |

A kid is `{ name, avatar, birthYear, monthlyEarning, earningDay }`:

- `birthYear` must make the child under 18 (this year − 17 … this year)
- `monthlyEarning` is a whole number of Kid Coins (0 – 1,000,000) credited every month as an **Earning**
- `earningDay` is the day of the month (1–31) it is credited; short months use their last day
- `avatar` is an emoji (defaults to 🦊)

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
