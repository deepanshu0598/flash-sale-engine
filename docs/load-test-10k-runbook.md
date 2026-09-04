# 10K VU Load Test — Runbook

> **Status: not yet run.** This is a complete, copy-paste-ready runbook for validating the
> 10K-concurrent claim end-to-end on real Linux infrastructure. It requires an AWS account and
> will incur real (small) cost — a `c5.xlarge` for ~1 hour is a few cents to low single-digit
> dollars, but nothing here should be run without deliberately choosing to spend that.
>
> **Why this exists instead of a result:** local testing on Windows hits the OS TCP listen
> backlog (~200 pending connections) before requests ever reach the application — see
> `README.md`'s "10K VUs — requires Linux + tuned kernel" section. The architecture is designed
> for 10K+ (lock-free Lua + 4 replicas + tuned nginx), verified at 1K end-to-end, and reasoned
> about at 10K — but reasoning isn't a substitute for a real number. This runbook is that missing
> step, ready to run whenever cloud access is available.

## Architecture for this test

```
[k6 client machine]  ──HTTP──>  [server VM: nginx :3000 → 4 app replicas → postgres/redis]
     (separate box — see "Why two machines" below)
```

### Why two machines, not one

Running k6 on the same VM as the server means k6's own CPU/network usage competes with the
application for resources, and you end up measuring "how fast can this VM saturate itself"
rather than real network-path latency. Use two separate instances (or run k6 from your laptop
against the server's public IP if your local bandwidth/CPU can sustain 10K VUs — a `c5.xlarge`
running k6 is the safer choice).

## 1. Provision the server VM

```bash
# Adjust region/AMI as needed — this is Ubuntu 22.04 LTS in us-east-1.
# Find the current AMI for your region: https://cloud-images.ubuntu.com/locator/ec2/
aws ec2 run-instances \
  --image-id ami-0c7217cdde317cfec \
  --instance-type c5.xlarge \
  --key-name YOUR_KEY_PAIR_NAME \
  --security-group-ids YOUR_SG_ID \
  --subnet-id YOUR_SUBNET_ID \
  --count 1 \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=flash-sale-load-test}]'
```

Security group needs inbound: `22` (SSH, from your IP), `3000` (app, from the k6 machine's IP —
or `0.0.0.0/0` for a short-lived test instance, tightened back down after).

```bash
# Get the public IP once it's running
aws ec2 describe-instances --filters "Name=tag:Name,Values=flash-sale-load-test" \
  --query 'Reservations[].Instances[].PublicIpAddress' --output text
```

## 2. Set up the server

```bash
ssh -i YOUR_KEY.pem ubuntu@<SERVER_PUBLIC_IP>

# Docker + Compose plugin
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker

# Clone and build
git clone https://github.com/deepanshu0598/flash-sale-engine.git
cd flash-sale-engine
cp .env.example .env   # edit JWT_SECRET etc. if you want non-default values

# Apply kernel tuning (see scripts/tune-kernel-for-load-test.sh — copy it over
# via scp, or paste its contents directly)
chmod +x scripts/tune-kernel-for-load-test.sh
./scripts/tune-kernel-for-load-test.sh

# Bring up 4 replicas + nginx + postgres + redis
# (`--scale` is required — see the note in docker-compose.yml about
# `deploy.replicas` being a Swarm-only no-op under plain `docker compose up`)
docker compose up -d --build --scale app=4

# Wait for health, then migrate + seed
docker compose ps   # postgres/redis should show "healthy"
npm run migration:run   # or: docker compose exec app node dist/... if npm isn't installed on the VM
npm run seed
```

## 3. Create a sale sized for a 10K test

The default seed creates 10 sales with `totalStock` in the 50–300 range and `maxPerUser` 1–3 —
too small for a 10K-VU run (it'll sell out in the first few hundred requests, and you'll mostly
be measuring the fast 409 pre-check path rather than the full purchase path under sustained
load). Create one specifically for this test:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@flashsale.com","password":"password123"}' | jq -r '.access_token')

PRODUCT_ID=$(curl -s http://localhost:3000/products -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id')

SALE_ID=$(curl -s -X POST http://localhost:3000/flash-sales \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"productId\":\"$PRODUCT_ID\",\"salePrice\":999,\"totalStock\":5000,\"maxPerUser\":50,\"startTime\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"endTime\":\"$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%S.000Z)\"}" \
  | jq -r '.id')

echo "SALE_ID=$SALE_ID"
```

`maxPerUser: 50` matters: each k6 VU calls `/purchase` once per second for the whole test
duration (see `test/load/flash-sale.k6.js`'s `sleep(1)`), so a low `maxPerUser` means most
requests after the first one per VU get rejected with 400 (limit exceeded) instead of exercising
the real purchase path — that would measure the fast-reject path, not the thing this test exists
to validate.

## 4. Run k6 from the second machine

```bash
# On the k6 machine (NOT the server) — install k6 if not already present:
#   https://k6.io/docs/get-started/installation

MAX_VUS=10000 POOL_SIZE=500 k6 run \
  --env BASE_URL=http://<SERVER_PUBLIC_IP>:3000 \
  --env SALE_ID=<SALE_ID from step 3> \
  --env MAX_VUS=10000 \
  --env POOL_SIZE=500 \
  test/load/flash-sale.k6.js
```

The script is already env-driven (see `test/load/flash-sale.k6.js` — `MAX_VUS`, `POOL_SIZE`
read from `__ENV`) — no code changes needed for this run, only the env vars above.

## 5. What to look for

| Metric | Where | What "good" looks like |
|---|---|---|
| `error_rate` (5xx only) | k6 output | < 1% (ideally 0%, matching the 1K result) |
| `http_req_duration` p(95) | k6 output | Compare against the 1K result (159ms) — some increase is expected, a cliff (10x+) means a real bottleneck was found |
| `successful_purchases` | k6 output | Should approach `totalStock` (5000) as the sale depletes |
| `order_queue_depth` | Grafana (`http://<SERVER_PUBLIC_IP>:3001`) | Should track down to 0 after the ramp-down, not grow unbounded (unbounded growth = the worker can't keep up with purchase throughput) |
| `db_pool_waiting` | Grafana | Should stay near 0 — sustained > 0 means the 50-connection pool is undersized for this load |
| `redis_pool_connected` | Grafana | Should stay at 5 throughout — any dip indicates connection instability under load |

## 6. Tear down

```bash
# On your local machine, not the server
aws ec2 terminate-instances --instance-ids <INSTANCE_ID>
```

Don't skip this — a `c5.xlarge` left running is the actual cost risk here, not the hour of
testing itself.

## After running: update the README

Replace the "10K VUs — requires Linux + tuned kernel" section in `README.md` with the real
numbers, and update the roadmap's Phase 4 entry from planned to `✓ shipped`.
