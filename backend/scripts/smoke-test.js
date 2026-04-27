'use strict';

const BASE = process.env.BASE || 'http://localhost:4000';
const cookies = [];

function jar(setCookie) {
  if (!setCookie) return;
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const sc of arr) cookies.push(sc.split(';')[0]);
}

async function call(path, method = 'GET', body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookies.length ? { Cookie: cookies.join('; ') } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  jar(res.headers.getSetCookie?.() || res.headers.get('set-cookie'));
  const text = await res.text();
  return `${res.status} ${text}`;
}

(async () => {
  const email = `smoke_${Date.now()}@x.com`;
  console.log('signup:    ', await call('/api/auth/signup', 'POST', { email, password: 'password123' }));
  console.log('me:        ', await call('/api/auth/me'));
  console.log('plans:     ', await call('/api/auth/plans'));
  console.log('key1:      ', await call('/api/auth/keys', 'POST', { name: 'prod' }));
  console.log('keys list: ', await call('/api/auth/keys'));
  console.log('key2(403): ', await call('/api/auth/keys', 'POST', { name: 'second' }));
  console.log('checkout:  ', await call('/api/auth/checkout', 'POST', { plan_id: 'starter' }));
  console.log('one-time:  ', await call('/api/auth/keys', 'POST', { name: 'one-shot', one_time_use: true, ttl_minutes: 60 }));
  console.log('payments:  ', await call('/api/auth/payments'));
  console.log('forgot:    ', await call('/api/auth/forgot', 'POST', { email }));
  console.log('badreset:  ', await call('/api/auth/reset', 'POST', { token: 'bogus', password: 'newpass123' }));
  console.log('proxy 401: ', await call('/v1/chat/completions', 'POST', { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }));
  console.log('admin 403: ', await call('/api/admin/pool'));
})();
