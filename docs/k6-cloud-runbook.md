# k6 Cloud / Distributed Load Test — Runbook

> **Status: not yet run.** Requires a Grafana Cloud k6 account (free tier includes a limited
> number of cloud test minutes; beyond that it's paid). This runbook is ready to execute the
> moment that account exists — no code changes needed, `test/load/flash-sale.k6.js` is already
> env-driven.

## Why this is a separate item from the 10K VU runbook

The [10K VU runbook](./load-test-10k-runbook.md) proves the server can handle 10K concurrent
connections from a single load-generating machine. This runbook proves something different:
**distributed** load — multiple k6 agents in different locations firing at the server
simultaneously, which is closer to what real traffic during an actual flash sale looks like
(not one datacenter's worth of connections, many). It also removes the single-k6-machine
resource ceiling — a laptop or single EC2 instance can only generate so many concurrent virtual
users before k6 itself becomes the bottleneck.

## 1. Get a k6 Cloud account + API token

1. Sign up at https://grafana.com/products/cloud/k6/ (or via Grafana Cloud, which now hosts k6
   Cloud).
2. Get your API token from the k6 Cloud UI (Settings → API token), or:

   ```bash
   k6 login cloud
   # follow the prompt — this stores the token in ~/.config/k6/loginstate.json
   ```

## 2. Point the test at a running server

The server needs to be reachable from the public internet — either the AWS VM from the
[10K VU runbook](./load-test-10k-runbook.md) (reuse it, don't provision a second one just for
this), or any other publicly reachable deployment.

```bash
# Same seed steps as the 10K VU runbook (step 3 there) — a sale sized for
# sustained multi-minute load, not the small default seed sales.
```

## 3. Run distributed across k6 Cloud's agents

```bash
k6 cloud run \
  --env BASE_URL=http://<SERVER_PUBLIC_IP>:3000 \
  --env SALE_ID=<SALE_ID> \
  --env MAX_VUS=10000 \
  --env POOL_SIZE=500 \
  test/load/flash-sale.k6.js
```

`k6 cloud run` (not `k6 run`) is what distributes execution across k6 Cloud's agents instead of
running locally. Everything else about the invocation is identical to a local run — same script,
same env vars.

### Distributing load geographically (optional)

By default k6 Cloud picks load zones automatically. To split VUs across specific regions
(closer to "real" traffic distribution), add a `cloud` block to the k6 script's `options`:

```javascript
export const options = {
  // ...existing scenarios/thresholds...
  cloud: {
    distribution: {
      'amazon:us:ashburn':   { loadZone: 'amazon:us:ashburn',   percent: 50 },
      'amazon:ie:dublin':    { loadZone: 'amazon:ie:dublin',    percent: 30 },
      'amazon:sg:singapore': { loadZone: 'amazon:sg:singapore', percent: 20 },
    },
  },
};
```

This is the one code change this runbook would require, and it's optional — omit it to let k6
Cloud choose automatically.

## 4. Where results show up

k6 Cloud gives a shareable results URL after the run (`k6 cloud run` prints it) — no need to
capture terminal output manually like the local runbook does. It includes per-region breakdowns
if you used the `cloud.distribution` block above.

## 5. What to look for

Same metrics table as the [10K VU runbook](./load-test-10k-runbook.md#5-what-to-look-for),
plus: compare latency **across regions** if distributed — a region far from the server's AWS
region should show meaningfully higher latency (that's expected network RTT, not a bug) while
error rate should stay consistent across all regions (a region-specific error spike would
indicate something regional, e.g. a firewall/routing issue, not an application bug).

## After running: update the README

Same as the 10K VU runbook — replace the planned-but-unverified language with real numbers and
the k6 Cloud results URL (if you're comfortable sharing it), and mark this Phase 4 item shipped.
