// Local tests: node test/run.mjs  (runs the worker in Miniflare with an in-memory bucket)
import { Miniflare } from 'miniflare';
import { createHmac, generateKeyPairSync, createSign } from 'node:crypto';
import http from 'node:http';

const SECRET = 'test-app-secret';
const DL = 'test-download-secret';
const ORIGIN = 'https://apex-feeds-dev.myshopify.com';

// Fake Cloudflare Access certs endpoint
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
const certServer = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
await new Promise((r) => certServer.listen(0, r));
const team = `127.0.0.1:${certServer.address().port}`;

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function accessToken(payload) {
  const h = b64({ alg: 'RS256', kid: 'k1' }), p = b64(payload);
  const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(privateKey).toString('base64url');
  return `${h}.${p}.${s}`;
}
function sessionToken(payload, secret = SECRET) {
  const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64(payload);
  return `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
}
function proxyQuery(params, secret = SECRET) {
  const msg = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('');
  return new URLSearchParams({ ...params, signature: createHmac('sha256', secret).update(msg).digest('hex') }).toString();
}

const mf = new Miniflare({
  modules: true,
  scriptPath: 'src/index.js',
  compatibilityDate: '2026-08-01',
  r2Buckets: ['DOCS'],
  bindings: {
    ALLOWED_ORIGINS: ORIGIN, PUBLIC_URL: 'https://docs.example.com', SHOPIFY_SHOP: 'apex-feeds-dev.myshopify.com',
    SHOPIFY_API_KEY: 'client-id', ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'aud1', ADMIN_EMAILS: 'james@example.com',
    SHOPIFY_API_SECRET: SECRET, DOWNLOAD_SECRET: DL,
  },
  outboundService: async (req) => fetch(req.url.replace('https://', 'http://')),
});
const base = 'http://localhost';
const go = async (path, init = {}) => {
  if (init.body instanceof FormData) {
    const packed = new Response(init.body);
    init = { ...init, body: await packed.arrayBuffer(), headers: { ...(init.headers || {}), 'Content-Type': packed.headers.get('Content-Type') } };
  }
  return mf.dispatchFetch(base + path, init);
};
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${cond ? '' : extra}`); if (!cond) failed++; };

const pdf = new Blob([Buffer.from('%PDF-1.4\n%test\n')], { type: 'application/pdf' });
const png = new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], { type: 'image/png' });
const fake = new Blob([Buffer.from('<script>alert(1)</script>')], { type: 'application/pdf' });
const upload = (file, name, origin = ORIGIN, app = 'abc12345xyz') => { const f = new FormData(); f.set('file', file, name); f.set('application', app); f.set('label', 'Shopfront photo'); return go('/upload', { method: 'POST', body: f, headers: origin ? { Origin: origin } : {} }); };

// Uploads
let r = await upload(png, 'Front of store.png');
let body = await r.json();
check('upload png from store', r.status === 200 && body.key.startsWith('applications/') && body.link.includes('/admin/file?key='), JSON.stringify(body));
check('CORS header set', r.headers.get('Access-Control-Allow-Origin') === ORIGIN);
r = await upload(png, 'x.png', 'https://evil.example'); check('upload from other site refused', r.status === 403);
r = await upload(png, 'x.png', null); check('upload with no origin refused', r.status === 403);
r = await upload(fake, 'x.pdf'); check('fake pdf (html) refused', r.status === 415);
r = await upload(new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]), 'big.pdf'); check('over 10MB refused', r.status === 413);
r = await upload(pdf, 'x.pdf', ORIGIN, 'bad/../ref'); check('bad application ref refused', r.status === 400);
r = await go('/upload', { method: 'OPTIONS', headers: { Origin: ORIGIN } }); check('preflight ok', r.status === 204);
for (let i = 0; i < 12; i++) await upload(pdf, `f${i}.pdf`, ORIGIN, 'limit1234');
r = await upload(pdf, 'f13.pdf', ORIGIN, 'limit1234'); check('max files per application', r.status === 429);

// Admin
const key = body.key;
r = await go(`/admin/file?key=${encodeURIComponent(key)}`); check('admin without login refused', r.status === 401);
const good = accessToken({ aud: ['aud1'], email: 'James@example.com', exp: Date.now() / 1000 + 600, iss: `https://${team}` });
const admin = { 'Cf-Access-Jwt-Assertion': good };
r = await go(`/admin/file?key=${encodeURIComponent(key)}`, { headers: admin }); check('admin opens file', r.status === 200 && r.headers.get('Content-Type') === 'image/png');
r = await go(`/admin/file?key=${encodeURIComponent(key)}`, { headers: { 'Cf-Access-Jwt-Assertion': accessToken({ aud: ['aud1'], email: 'someone@else.com', exp: Date.now() / 1000 + 600, iss: `https://${team}` }) } });
check('non-admin email refused', r.status === 403);
r = await go(`/admin/file?key=${encodeURIComponent(key)}`, { headers: { 'Cf-Access-Jwt-Assertion': accessToken({ aud: ['other'], email: 'james@example.com', exp: Date.now() / 1000 + 600, iss: `https://${team}` }) } });
check('wrong Access audience refused', r.status === 401);
r = await go(`/admin/file?key=${encodeURIComponent(key)}`, { headers: { 'Cf-Access-Jwt-Assertion': good.slice(0, -4) + 'AAAA' } }); check('tampered Access token refused', r.status === 401);
r = await go('/admin', { headers: admin }); let html = await r.text(); check('admin page lists application', r.status === 200 && html.includes('abc12345xyz'));

let f = new FormData(); f.set('customer', '8471234567890'); f.set('title', 'Wholesale agreement 2026'); f.set('signed', '2026-11-18');
f.append('file', pdf, 'Signed agreement.pdf'); f.append('file', png, 'Signed page.png');
r = await go('/admin/agreements', { method: 'POST', body: f, headers: { ...admin, Origin: base }, redirect: 'manual' }); check('admin uploads agreement PDF + photo together', r.status === 303);
r = await go('/admin', { headers: admin }); html = await r.text(); check('admin page groups the agreement files', html.includes('Agreement (PDF)') && html.includes('Signed page') && html.includes('signed 2026-11-18'));
f = new FormData(); f.set('customer', '8471234567890'); f.append('file', pdf, 'ok.pdf'); f.append('file', fake, 'not-really.pdf');
r = await go('/admin/agreements', { method: 'POST', body: f, headers: admin }); check('agreement with a fake file refused', r.status === 415);
f = new FormData(); f.set('customer', '8471234567890'); for (let i = 0; i < 7; i++) f.append('file', pdf, `p${i}.pdf`);
r = await go('/admin/agreements', { method: 'POST', body: f, headers: admin }); check('more than 6 files refused', r.status === 400);
f = new FormData(); f.set('customer', '1234567'); f.set('file', pdf, 'a.pdf');
r = await go('/admin/agreements', { method: 'POST', body: f, headers: { ...admin, Origin: 'https://evil.example' } }); check('cross-site admin post refused', r.status === 403);

// Customer via app proxy
const now = Math.floor(Date.now() / 1000);
const q = (cust, extra = {}) => proxyQuery({ shop: 'apex-feeds-dev.myshopify.com', path_prefix: '/apps/apex-docs', timestamp: String(now), logged_in_customer_id: cust, ...extra });
r = await go(`/proxy/agreements?${q('8471234567890')}`); body = await r.json();
check('customer sees own agreement', r.status === 200 && body.agreements.length === 1 && body.agreements[0].title === 'Wholesale agreement 2026', JSON.stringify(body));
const ag = body.agreements[0];
check('agreement is marked signed with its date and both files', ag.signed === true && ag.signedOn === '2026-11-18' && ag.files.length === 2 && ag.files[0].type === 'application/pdf' && ag.files[1].type === 'image/png' && ag.files[1].label === 'Signed page', JSON.stringify(ag));
r = await go(ag.files[1].url.replace('https://docs.example.com', '')); check('signed page photo opens by link', r.status === 200 && r.headers.get('Content-Type') === 'image/png');
const link = body.agreements[0].url.replace('https://docs.example.com', '');
r = await go(link); check('signed download link works', r.status === 200 && r.headers.get('Content-Type') === 'application/pdf');
r = await go(link.replace(/sig=[0-9a-f]{4}/, 'sig=0000')); check('tampered download link refused', r.status === 403);
r = await go(link.replace(/exp=\d+/, 'exp=1')); check('expired/altered link refused', r.status === 410 || r.status === 403);
r = await go(`/d/${encodeURIComponent(key)}?exp=${now + 100}&sig=abc`); check('application files not downloadable by link', r.status === 404);
r = await go(`/proxy/agreements?${q('999999')}`); body = await r.json(); check('other customer sees nothing', body.agreements.length === 0);
r = await go(`/proxy/agreements?${q('8471234567890').replace('logged_in_customer_id=8471234567890', 'logged_in_customer_id=1111111')}`); check('changed customer id refused', r.status === 401);
r = await go(`/proxy/agreements?${proxyQuery({ shop: 'apex-feeds-dev.myshopify.com', timestamp: String(now), logged_in_customer_id: '8471234567890' }, 'wrong')}`); check('wrong secret refused', r.status === 401);
r = await go(`/proxy/agreements?${q('')}`); check('logged out refused', r.status === 401);
r = await go(`/proxy/agreements?${proxyQuery({ shop: 'apex-feeds-dev.myshopify.com', timestamp: String(now - 3600), logged_in_customer_id: '8471234567890' })}`); check('old proxy request refused', r.status === 401);

// Customer account extension
const st = (sub, extra = {}, secret) => ({ Authorization: `Bearer ${sessionToken({ sub, aud: 'client-id', dest: 'apex-feeds-dev.myshopify.com', exp: now + 60, nbf: now - 1, ...extra }, secret)}` });
r = await go('/ext/agreements', { headers: st('gid://shopify/Customer/8471234567890') }); body = await r.json(); check('extension sees own agreement', r.status === 200 && body.agreements.length === 1);
r = await go('/ext/agreements', { headers: st('gid://shopify/Customer/8471234567890', {}, 'wrong') }); check('extension bad signature refused', r.status === 401);
r = await go('/ext/agreements', { headers: st('gid://shopify/Customer/8471234567890', { exp: now - 100 }) }); check('extension expired token refused', r.status === 401);
r = await go('/ext/agreements', { headers: st('gid://shopify/Customer/8471234567890', { aud: 'another-app' }) }); check('extension other app refused', r.status === 401);
r = await go('/ext/agreements'); check('extension no token refused', r.status === 401);

// Delete
f = new FormData(); f.set('key', '../../etc'); r = await go('/admin/delete', { method: 'POST', body: f, headers: admin }); check('delete outside folders refused', r.status === 400);

// Storage and daily limits (kept under Cloudflare's free allowance)
const opts = (extra) => ({
  modules: true, scriptPath: 'src/index.js', compatibilityDate: '2026-08-01', r2Buckets: ['DOCS'],
  bindings: {
    ALLOWED_ORIGINS: ORIGIN, PUBLIC_URL: 'https://docs.example.com', SHOPIFY_SHOP: 'apex-feeds-dev.myshopify.com',
    SHOPIFY_API_KEY: 'client-id', ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'aud1', ADMIN_EMAILS: 'james@example.com',
    SHOPIFY_API_SECRET: SECRET, DOWNLOAD_SECRET: DL, ...extra,
  },
  outboundService: async (req) => fetch(req.url.replace('https://', 'http://')),
});
await mf.setOptions(opts({ STORAGE_LIMIT_GB: '0.0000001' }));
r = await upload(pdf, 'full.pdf', ORIGIN, 'storage1234'); check('upload refused when storage limit reached', r.status === 507);
await mf.setOptions(opts({ DAILY_UPLOAD_LIMIT: '1' }));
await upload(pdf, 'day1.pdf', ORIGIN, 'daily1234');
r = await upload(pdf, 'day2.pdf', ORIGIN, 'daily5678'); check('uploads paused after daily limit', r.status === 429 && (await r.json()).error?.includes('paused') !== false);

await mf.dispose(); certServer.close();
console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
process.exit(failed ? 1 : 0);
