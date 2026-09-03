# Flash Sale Engine

> Handles 1,000+ concurrent buyers for limited-stock items without overselling.
> Built with NestJS, Redis, BullMQ, and PostgreSQL.

[![CI](https://github.com/deepanshu0598/flash-sale-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/deepanshu0598/flash-sale-engine/actions/workflows/ci.yml)

---

## The Problem

When thousands of users hit "Buy Now" at the same time for a product with `stock = 100`:

```
Without protection:
  Worker A reads stock = 100 ✓
  Worker B reads stock = 100 ✓      ← both read before either writes
  Worker A writes stock = 99 ✓
  Worker B writes stock = 99 ✗      ← should be 98. You just sold 101 units.

With this engine:
  Lua script runs atomically → check + decrement = one uninterruptible Redis operation
  Distributed lock → only one worker enters the critical section per sale
  Result: exactly 100 orders, never 101
```

---

## Architecture

```
HTTP Clients (1000+ concurrent)
         │
  [NestJS API :3000]
         │
         ├──→ Step 0: Redis GET inventory:{saleId}   ← instant 409 if sold out (no lock)
         │
         ├──→ Step 1: Redis cache-aside sale lookup  ← avoids DB hit on every request
         │
         ├──→ Step 2: Redis SET NX EX (distributed lock)
         │
         ├──→ Step 3: PostgreSQL — per-user limit check (inside lock)
         │
         ├──→ Step 4: Redis Lua — atomic stock deduction
         │              └── returns -1 → 409 Sold out
         │              └── returns -2 → 500 Not initialized
         │              └── returns N  → stock remaining
         │
         ├──→ Step 5: PostgreSQL — INSERT order (status: PENDING)
         │
         ├──→ Step 6: BullMQ — enqueue PROCESS_ORDER job
         │
         └──→ Step 7: Redis — release lock (always, in finally block)

[BullMQ Worker — same process]
  ← picks up job
  ← simulates payment (150ms)
  ← PostgreSQL UPDATE order (status: CONFIRMED)
  ← PostgreSQL INCREMENT flash_sales.soldCount

[Bull Board  :3000/queues]  ← monitor jobs visually
[Swagger     :3000/api]     ← interactive API docs
[Health      :3000/health]  ← readiness probe
```

---

## Key Engineering Decisions

**1. Lua script over MULTI/EXEC for inventory deduction**

Lua executes atomically inside Redis — the check-and-decrement is a single uninterruptible operation. MULTI/EXEC (optimistic locking) can fail under high contention and requires client-side retry logic. Lua always wins on the first attempt.

**2. Distributed lock per sale, not per user**

The lock serializes concurrent writes to the same sale. A per-user lock would allow two requests from the same user to both pass the limit check simultaneously (classic TOCTOU race). The per-user limit check lives *inside* the lock for this exact reason.

**3. Redis as stock source of truth during sale window**

All reads and writes during a flash sale hit Redis, not PostgreSQL. This keeps the DB free of 10K concurrent SELECT/UPDATE queries. The DB receives only confirmed orders via the BullMQ queue — decoupled from the hot path.

**4. BullMQ for async order processing**

The HTTP response returns in < 100ms with `orderId` + `jobId`. Payment processing, soldCount increment, and status updates happen asynchronously. Failed jobs retry up to 3 times with exponential backoff.

**5. Step 0 fast pre-check**

A plain Redis GET before lock acquisition rejects "definitely sold out" requests instantly (~0.1ms). This drops 95%+ of requests before they ever compete for the lock once stock is depleted.

---

## Load Test Results (k6)

**Setup:** 1,000 virtual users, ramping 0 → 1000 → 0 over 50 seconds. Single Node.js process.

```
  ✓ error_rate          rate=0.00%        (no 5xx errors)
  ✓ successful_purchases count=254        (lock correctly serialized purchases)
  ✓ http_req_duration   p(95)=3.4s       (lock-wait bound under 1000 VUs)

  sold_out_responses.......: 9,232   (fast Redis pre-check path — no lock acquired)
  successful_purchases.....: 254
  error_rate...............: 0.00%
  http_req_failed..........: 97.31% (k6 counts 409 as failed — all expected 409s)
```

> `http_req_failed` counts 4xx — the 97% "failures" are all correct 409 Sold Out responses,
> not errors. Zero 5xx means the system never crashed under load.

---

## Quick Start

**Prerequisites:** Docker, Node.js 20+

```bash
# 1. Start infrastructure
docker-compose up -d

# 2. Install dependencies
npm install

# 3. Run DB migrations
npm run migration:run

# 4. Seed 10K users + 50 products + 10 flash sales
npm run seed

# 5. Start the server
npm run start:dev
```

**Test the purchase flow:**
```bash
# Login
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@flashsale.com","password":"password123"}' \
  | jq -r '.access_token')

# Get a sale ID
SALE_ID=$(curl -s http://localhost:3000/flash-sales \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id')

# Purchase
curl -X POST http://localhost:3000/flash-sales/$SALE_ID/purchase \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"quantity": 1}'
```

---

## Testing

```bash
# Unit tests (15 tests — all purchase() critical paths)
npm test

# E2E tests (no-oversell proof: 20 concurrent requests, stock=5, succeeded <= 5)
npm run test:e2e

# Load test (requires k6)
BASE_URL=http://localhost:3000 SALE_ID=<your-sale-id> k6 run test/load/flash-sale.k6.js
```

---

## API Overview

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/auth/register` | Register a new user |
| POST | `/auth/login` | Login, returns JWT token |
| GET | `/products` | List all products |
| POST | `/products` | Create a product |
| GET | `/flash-sales` | List sales with live Redis stock |
| POST | `/flash-sales` | Create a flash sale |
| POST | `/flash-sales/:id/purchase` | Purchase (the core endpoint) |
| GET | `/orders/:id` | Track order status |
| GET | `/health` | Health check |
| GET | `/queues` | Bull Board job monitor |
| GET | `/api` | Swagger UI |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| API Framework | NestJS 12 (ESM) |
| Language | TypeScript |
| Database | PostgreSQL 16 + TypeORM |
| Cache / Lock | Redis 7 + ioredis |
| Queue | BullMQ + @nestjs/bull |
| Auth | JWT + Passport |
| Testing | Vitest + supertest |
| Load Testing | k6 |
| CI | GitHub Actions |
| Infrastructure | Docker Compose |
