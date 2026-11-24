# Outboxly — Full-Stack Email Job Scheduler

A production-grade email scheduling service and operational dashboard built with **TypeScript, Express.js, BullMQ + Redis, PostgreSQL (Drizzle ORM), Ethereal Email SMTP, Elasticsearch, Slack OAuth v2, and React + Tailwind CSS**.

---

## Architecture Overview

### 1. Persistent Job Scheduling (Zero Cron)
- Incoming batches via `POST /api/emails/schedule` validate and deduplicate recipients, create an `email_batches` record and individual `emails` rows in PostgreSQL, index documents into Elasticsearch, and enqueue BullMQ delayed jobs (`delay = max(0, scheduledAt - now)`) in Redis.
- No OS-level cron, `node-cron`, or `agenda` polling is used.

### 2. Restart Persistence & Idempotency
- Every email row has a deterministic unique `idempotencyKey` (SHA-256 of `userId + senderId + batchKey + recipientEmail`) enforced by a PostgreSQL unique constraint and used as the BullMQ `jobId`.
- Before sending via SMTP, the worker executes an atomic PostgreSQL claim:
  `UPDATE emails SET status = 'processing' WHERE id = $1 AND status IN ('scheduled', 'delayed') AND sent_at IS NULL RETURNING *`.
- On server startup (`initEmailScheduler` -> `rehydratePendingEmails`), any rows stuck in `processing` without `sent_at` are recovered to `scheduled`, and any pending DB emails missing from Redis are re-enqueued using their original `idempotencyKey` and `scheduledAt`. Already-sent emails are never re-sent.

### 3. Concurrency, Inter-Send Delay & Distributed Hourly Rate Limiting
- **Worker Concurrency**: Configured via `WORKER_CONCURRENCY` (default `5`).
- **Minimum Delay Between Sends**: Configured via `MIN_DELAY_BETWEEN_EMAILS_MS` (default `2000ms`) or per-batch Compose setting. Enforced safely across parallel workers using an atomic Redis `SET ratelimit:spacing:<senderId> 1 PX <delayMs> NX` lock. If another email for the same sender was sent within the delay window, the job is moved cleanly with `job.moveToDelayed(...)` + `DelayedError` without failing or consuming hourly quota.
- **Per-Sender Hourly Rate Limit**: Configured via `MAX_EMAILS_PER_HOUR_PER_SENDER` (default `200`) and optional per-sender/batch caps. Enforced atomically across workers via a Redis Lua script incrementing `ratelimit:sender:<senderId>:<YYYY-MM-DD-HH>` with a 3700s TTL.
- **Behavior Under Load (1,000+ Emails / Rate Limit Exceeded)**:
  - Overflow jobs are **never dropped or permanently failed**.
  - An atomic Redis overflow counter (`ratelimit:overflow:<senderId>:<nextHourWindow>`) assigns staggered slots starting at the next UTC hour boundary (and rolls across subsequent hours if overflow itself exceeds the hourly cap), preserving batch order and preventing thundering-herd spikes.

### 4. Slack Rate-Limit Alerts (OAuth v2)
- Users click **Connect Slack** in **Senders & Slack**, completing a real Slack OAuth v2 flow (`incoming-webhook`, `chat:write`) with HMAC-signed `state`.
- When a sender hits its hourly limit, a Redis `SET NX EX` dedupe key ensures a single real Slack alert is dispatched per sender per hour window detailing the sender, limit, and next reschedule timestamp.
- If Slack is disconnected, rate-limit events are logged to `rate_limit_logs` without throwing errors; reconnecting Slack resumes notifications immediately without redeploying.

### 5. Search & Queue Observability
- **Elasticsearch**: Emails are indexed into `reachinbox_emails` on creation and status transitions (`scheduled` -> `delayed` / `sent` / `failed`), powering `GET /api/emails/search`. If `ELASTICSEARCH_URL` is unset, search falls back cleanly to parameterized PostgreSQL `ILIKE` queries.
- **Live BullMQ Dashboard**: `@bull-board/express` is mounted at `/admin/queues`, alongside an in-app **Queue Monitor** view polling live queue counts and per-sender hourly usage.

---

## Features Implemented

| Area | Implemented Capabilities |
| :--- | :--- |
| **Backend Scheduler** | Express + TypeScript API, BullMQ delayed queues, configurable `WORKER_CONCURRENCY`, startup DB-to-Redis rehydration, idempotency keys |
| **Rate Limiting & SMTP** | Redis Lua atomic hourly counters per sender, distributed spacing locks, staggered next-hour overflow rescheduling, multi-sender Ethereal SMTP (`nodemailer.createTestAccount()` + custom SMTP) |
| **Search & Observability** | Elasticsearch indexing & multi-field search (with PG fallback), `@bull-board/express` at `/admin/queues`, live `/api/queues/stats` telemetry |
| **Integrations** | Real Google Sign-In (Firebase Auth ID token verification), real Slack OAuth v2 popup flow & live rate-limit webhook notifications |
| **Frontend Dashboard** | Google Login screen, sidebar workspace shell, Compose modal with CSV/TXT parsing & recipient count, Scheduled & Sent email tables, Queue Monitor, Senders & Slack settings |

---

## Running Locally

### 1. Start Redis & Elasticsearch (Docker)
```bash
docker compose up -d
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env` and populate values:
- `SQL_HOST`, `SQL_DB_NAME`, `SQL_USER`, `SQL_PASSWORD`, `SQL_ADMIN_USER`, `SQL_ADMIN_PASSWORD` (PostgreSQL)
- `REDIS_URL=redis://127.0.0.1:6379`
- `ELASTICSEARCH_URL=http://127.0.0.1:9200`
- `SLACK_CLIENT_ID` & `SLACK_CLIENT_SECRET` (from your Slack App, with redirect URL `<APP_URL>/api/slack/callback`)
- `WORKER_CONCURRENCY=5`
- `MIN_DELAY_BETWEEN_EMAILS_MS=2000`
- `MAX_EMAILS_PER_HOUR_PER_SENDER=200`
- `ETHEREAL_AUTO_PROVISION=true`

### 3. Install & Run
```bash
npm install
npx drizzle-kit push --config=src/db/drizzle.config.ts
npm run dev
```
Open `http://localhost:3000` (and `/admin/queues` for Bull Board).

## Deploying to Render

This repository includes a Render Blueprint (`render.yaml`) that provisions the web service, PostgreSQL, and Redis in Singapore. In Render, create a new Blueprint deployment from this GitHub repository and select the `main` branch. The first deploy will build the Vite frontend, apply the Drizzle schema to PostgreSQL, and start the Express server.

The Blueprint uses Render's free plans, which are suitable for a demo and may sleep or have limited persistence/availability. For production email scheduling, use paid persistent PostgreSQL and Redis plans. Add optional secrets such as `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `RESEND_API_KEY` in the Render service environment. Set Slack's redirect URL to `<APP_URL>/api/slack/callback` after Render assigns the service URL.

---

## Assumptions & Trade-offs
1. **PostgreSQL + Drizzle ORM**: Uses PostgreSQL (Cloud SQL compatible) with Drizzle ORM and `node-postgres` pooling.
2. **Staggered Overflow Rescheduling**: Instead of failing or polling jobs every minute when an hourly cap is hit, overflow jobs compute exact future timestamps across subsequent hour windows via an atomic Redis slot counter.
3. **Graceful External Service Degradation**: If `REDIS_URL` or `ELASTICSEARCH_URL` is not configured in a cloud preview sandbox, the server boots cleanly without crashing—persisting scheduled batches in PostgreSQL and falling back to PostgreSQL search until external Redis/Elasticsearch URLs are supplied.
