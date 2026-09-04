import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';

// ─── Custom metrics ───────────────────────────────────────────────────────────
const soldOut = new Counter('sold_out_responses');   // 409 — expected, not an error
const success = new Counter('successful_purchases'); // 201 — actual purchases
const errRate = new Rate('error_rate');              // 5xx only

// ─── Config ───────────────────────────────────────────────────────────────────
// Override via env: MAX_VUS=10000 POOL_SIZE=500 (requires Linux + tuned kernel)
const MAX_VUS         = parseInt(__ENV.MAX_VUS  || '1000', 10);
const TOKEN_POOL_SIZE = parseInt(__ENV.POOL_SIZE || '200',  10);

// ─── Load profile ─────────────────────────────────────────────────────────────
export const options = {
  scenarios: {
    flash_sale: {
      executor: 'ramping-vus',
      stages: [
        { duration: '10s', target: Math.floor(MAX_VUS * 0.1) }, // warm up
        { duration: '30s', target: MAX_VUS },                    // ramp to peak
        { duration: '10s', target: 0       },                    // ramp down
      ],
    },
  },
  thresholds: {
    // Lock-free Lua — no serialization bottleneck, expect much lower p95
    http_req_duration:    ['p(95)<2000'], // 95% under 2s (was 5s with lock)
    error_rate:           ['rate<0.01'],  // less than 1% 5xx errors
    successful_purchases: ['count>0'],    // at least some purchases go through
  },
};

// ─── Setup: runs once — registers + logs in TOKEN_POOL_SIZE users ─────────────
export function setup() {
  const base = __ENV.BASE_URL;
  const headers = { 'Content-Type': 'application/json' };

  // Register k6-specific users (ignore 409 conflict if already exist)
  const registerBatch = Array.from({ length: TOKEN_POOL_SIZE }, (_, i) => ({
    method: 'POST',
    url: `${base}/auth/register`,
    body: JSON.stringify({
      name: `K6 VU ${i}`,
      email: `k6_vu_${i}@loadtest.com`,
      password: 'k6password123',
    }),
    params: { headers },
  }));
  http.batch(registerBatch);

  // Login all and collect tokens
  const loginBatch = Array.from({ length: TOKEN_POOL_SIZE }, (_, i) => ({
    method: 'POST',
    url: `${base}/auth/login`,
    body: JSON.stringify({
      email: `k6_vu_${i}@loadtest.com`,
      password: 'k6password123',
    }),
    params: { headers },
  }));
  const loginResponses = http.batch(loginBatch);

  const tokens = loginResponses
    .map((r) => r.json('access_token'))
    .filter(Boolean);

  if (tokens.length === 0) {
    throw new Error('Setup failed: no tokens obtained. Is the server running?');
  }

  console.log(`Setup complete: ${tokens.length}/${TOKEN_POOL_SIZE} tokens ready. Sale: ${__ENV.SALE_ID}`);
  return { tokens };
}

// ─── Main VU function ────────────────────────────────────────────────────────
// Each VU gets its own token from the pool — maxPerUser limit applies per user,
// not globally, so purchases are not blocked after the first VU succeeds.
export default function ({ tokens }) {
  const token = tokens[(__VU - 1) % tokens.length];

  const res = http.post(
    `${__ENV.BASE_URL}/flash-sales/${__ENV.SALE_ID}/purchase`,
    JSON.stringify({ quantity: 1 }),
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
    },
  );

  errRate.add(res.status >= 500);

  if (res.status === 201) success.add(1);
  if (res.status === 409) soldOut.add(1);

  check(res, {
    'no 5xx errors':               (r) => r.status < 500,
    'response is 201, 400, or 409': (r) => [201, 400, 409].includes(r.status),
  });

  sleep(1); // 1000 VUs × 1 req/s = 1000 req/s throughput
}
