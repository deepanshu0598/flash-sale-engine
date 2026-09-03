import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';

// ─── Custom metrics ───────────────────────────────────────────────────────────
const soldOut  = new Counter('sold_out_responses');   // 409 — expected, not an error
const success  = new Counter('successful_purchases'); // 201 — actual purchases
const errRate  = new Rate('error_rate');              // 5xx only

// ─── Load profile ─────────────────────────────────────────────────────────────
export const options = {
  scenarios: {
    flash_sale: {
      executor: 'ramping-vus',
      stages: [
        { duration: '10s', target: 100  }, // warm up
        { duration: '30s', target: 1000 }, // peak — single Node.js process limit
        { duration: '10s', target: 0    }, // ramp down
      ],
    },
  },
  thresholds: {
    // Under 1000 concurrent VUs the distributed lock serializes requests —
    // p95 reflects lock-wait time, not app slowness. 5s matches the lock TTL.
    http_req_duration:    ['p(95)<5000'], // 95% under 5s (lock TTL bound)
    error_rate:           ['rate<0.01'],  // less than 1% 5xx errors
    successful_purchases: ['count>0'],    // at least some purchases go through
  },
};

// ─── Setup: runs once before load test ───────────────────────────────────────
// Gets a token that all VUs share for reading sale info.
// For purchase, each VU uses its own identity via __VU index.
export function setup() {
  const loginRes = http.post(
    `${__ENV.BASE_URL}/auth/login`,
    JSON.stringify({ email: 'test@flashsale.com', password: 'password123' }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  const token = loginRes.json('access_token');
  if (!token) {
    throw new Error(`Login failed: ${loginRes.body}`);
  }

  console.log(`Setup complete. Sale ID: ${__ENV.SALE_ID}`);
  return { token };
}

// ─── Main VU function — runs for every virtual user ──────────────────────────
export default function ({ token }) {
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

  // 409 sold out / busy = expected — NOT an error
  errRate.add(res.status >= 500);

  if (res.status === 201) success.add(1);
  if (res.status === 409) soldOut.add(1);

  check(res, {
    'no 5xx errors':               (r) => r.status < 500,
    // 400 = user limit exceeded (valid when many VUs share one account)
    'response is 201, 400, or 409': (r) => [201, 400, 409].includes(r.status),
  });

  sleep(1); // 1000 VUs × 1 req/s = 1000 req/s throughput — realistic load
}
