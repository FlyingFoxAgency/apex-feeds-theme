// APEX Feeds wholesale document service (Cloudflare Worker + private R2 bucket).
//
// Routes
//   POST /upload                 Public. The wholesale application form uploads a document here.
//                                Only accepted from the store's own web addresses (ALLOWED_ORIGINS).
//   GET  /admin                  James's page: recent applications, agreements, upload an agreement.
//   GET  /admin/file?key=        Open one stored file.
//   POST /admin/agreements       Upload a signed agreement for a customer: up to 6 files in one go
//                                (the full PDF plus photos or scans of the signed pages).
//   POST /admin/delete           Delete one stored file.
//                                Every /admin route is behind Cloudflare Access and also checks
//                                the Access token itself (ACCESS_TEAM_DOMAIN + ACCESS_AUD).
//   GET  /proxy/agreements       Storefront, through a Shopify app proxy (/apps/apex-docs/agreements).
//                                Shopify signs the request and says which customer is logged in.
//   GET  /ext/agreements         Customer account extension. Bearer session token signed by Shopify.
//   GET  /d/<key>?exp=&sig=      Short-lived signed download link handed out by the two routes above.
//
// Nothing in the bucket is public. Files only leave through the routes above.

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES_PER_APPLICATION = 12;
// Cloudflare R2's free allowance is 10 GB of storage. New files are refused well before that, so the
// bucket can never grow into a paid tier. Both limits can be lowered with Worker variables.
const DEFAULT_STORAGE_LIMIT_GB = 8;
const DEFAULT_DAILY_UPLOAD_LIMIT = 200;
const DOWNLOAD_LINK_SECONDS = 10 * 60;
const PROXY_MAX_AGE_SECONDS = 5 * 60;
const MAX_FILES_PER_AGREEMENT = 6;
// Signed agreements: PDF, or a photo/scan of the signed page. HEIC is left out because most
// browsers can't show it to the wholesaler.
const AGREEMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

const FILE_TYPES = {
  'application/pdf': { ext: 'pdf', magic: (b) => ascii(b, 0, 4) === '%PDF' },
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', magic: (b) => b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' },
  'image/webp': { ext: 'webp', magic: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP' },
  'image/heic': { ext: 'heic', magic: (b) => ascii(b, 4, 4) === 'ftyp' },
  'image/heif': { ext: 'heic', magic: (b) => ascii(b, 4, 4) === 'ftyp' },
};

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) return json({ ok: false, error: error.message }, error.status, error.headers);
      console.error(error);
      return json({ ok: false, error: 'Something went wrong' }, 500);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (path === '/upload') {
    const cors = corsFor(request, env);
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
    try {
      return withHeaders(await handleUpload(request, env), cors);
    } catch (error) {
      if (error instanceof HttpError) error.headers = { ...error.headers, ...cors };
      throw error;
    }
  }

  if (path === '/admin' || path.startsWith('/admin/')) {
    const admin = await requireAdmin(request, env);
    if (path === '/admin' && method === 'GET') return adminPage(env, admin, url);
    if (path === '/admin/file' && method === 'GET') return streamFile(env, url.searchParams.get('key'), url.searchParams.has('download'));
    if (path === '/admin/agreements' && method === 'POST') return adminUploadAgreement(request, env);
    if (path === '/admin/delete' && method === 'POST') return adminDelete(request, env);
    throw new HttpError(404, 'Not found');
  }

  if (path === '/proxy/agreements' && method === 'GET') {
    const customerId = await verifyAppProxy(url, env);
    return json({ ok: true, agreements: await listAgreements(env, customerId, url) }, 200, { 'Cache-Control': 'no-store' });
  }

  if (path === '/ext/agreements') {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
    const customerId = await verifySessionToken(request, env);
    return json({ ok: true, agreements: await listAgreements(env, customerId, url) }, 200, { ...cors, 'Cache-Control': 'no-store' });
  }

  if (path.startsWith('/d/') && method === 'GET') {
    const key = decodeURIComponent(path.slice(3));
    await verifyDownloadLink(env, key, url.searchParams.get('exp'), url.searchParams.get('sig'));
    return streamFile(env, key, url.searchParams.has('download'));
  }

  if (path === '/' && method === 'GET') return new Response('APEX Feeds documents', { headers: { 'Content-Type': 'text/plain' } });
  throw new HttpError(404, 'Not found');
}

// ---------------------------------------------------------------- uploads from the application form

async function handleUpload(request, env) {
  const form = await readForm(request);
  const file = form.get('file');
  const applicationId = String(form.get('application') || '');
  const label = cleanText(form.get('label'), 60) || 'Document';

  if (!/^[a-z0-9]{8,40}$/i.test(applicationId)) throw new HttpError(400, 'Missing application reference');
  const checked = await checkFile(file);

  const day = new Date().toISOString().slice(0, 10);
  const prefix = `applications/${day}_${applicationId}/`;
  // One listing of the whole bucket covers all three limits (a single storage operation for under 1,000 files).
  const usage = await bucketUsage(env);
  await guardStorage(env, usage, checked.bytes.byteLength);
  const todayCount = usage.objects.filter((o) => o.key.startsWith(`applications/${day}_`)).length;
  if (todayCount >= numberVar(env.DAILY_UPLOAD_LIMIT, DEFAULT_DAILY_UPLOAD_LIMIT)) {
    throw new HttpError(429, 'Uploads are paused for today. Please try again tomorrow or email us your documents.');
  }
  const existingCount = usage.objects.filter((o) => o.key.startsWith(prefix)).length;
  if (existingCount >= MAX_FILES_PER_APPLICATION) throw new HttpError(429, `You can upload up to ${MAX_FILES_PER_APPLICATION} files`);

  const index = String(existingCount + 1).padStart(2, '0');
  const key = `${prefix}${index}-${slug(label)}-${safeName(file.name, checked.ext)}`;
  await env.DOCS.put(key, checked.bytes, {
    httpMetadata: { contentType: checked.type },
    customMetadata: { label, originalName: cleanText(file.name, 120), uploadedAt: new Date().toISOString() },
  });

  return json({ ok: true, key, name: cleanText(file.name, 120), size: checked.bytes.byteLength, link: `${publicUrl(env)}/admin/file?key=${encodeURIComponent(key)}` });
}

async function checkFile(file, allowed = null) {
  if (!file || typeof file === 'string') throw new HttpError(400, 'No file received');
  const name = file.name ? `"${cleanText(file.name, 60)}"` : 'That file';
  if (file.size === 0) throw new HttpError(400, `${name} is empty`);
  if (file.size > MAX_BYTES) throw new HttpError(413, `${name} is over 10 MB. Files must be 10 MB or smaller`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = Object.keys(FILE_TYPES).find((t) => FILE_TYPES[t].magic(bytes));
  if (!type || (allowed && !allowed.includes(type))) {
    throw new HttpError(415, allowed ? `${name} isn't a PDF, JPG, PNG or WEBP file` : 'Please upload a PDF, JPG, PNG, WEBP or HEIC file');
  }
  return { bytes, type, ext: FILE_TYPES[type].ext };
}

function corsFor(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = list(env.ALLOWED_ORIGINS);
  if (!allowed.includes(origin)) throw new HttpError(403, 'Uploads are only accepted from the Apex Feeds website');
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// ---------------------------------------------------------------- James's admin page

async function requireAdmin(request, env) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion') || cookie(request, 'CF_Authorization');
  if (!token) throw new HttpError(401, 'Sign in through Cloudflare Access');
  const payload = await verifyAccessJwt(token, env);
  const email = String(payload.email || '').toLowerCase();
  const admins = list(env.ADMIN_EMAILS).map((e) => e.toLowerCase());
  if (admins.length && !admins.includes(email)) throw new HttpError(403, 'This account is not allowed here');
  if (request.method === 'POST') {
    // Forms on the admin page post back to the same host. Refuse posts that come from anywhere else.
    const origin = request.headers.get('Origin');
    if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, 'Cross-site request refused');
  }
  return { email };
}

async function adminPage(env, admin, url) {
  const [applications, agreements] = await Promise.all([listAll(env, 'applications/'), listAll(env, 'agreements/')]);

  const groups = new Map();
  for (const object of applications) {
    const folder = object.key.split('/')[1];
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(object);
  }
  const appRows = [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 100)
    .map(([folder, objects]) => {
      const [day, ref] = folder.split('_');
      const files = objects.map((o) => fileLink(o)).join('');
      return `<tr><td>${esc(day)}</td><td><code>${esc(ref)}</code></td><td>${files}</td></tr>`;
    })
    .join('');

  const byCustomer = new Map();
  for (const object of agreements) {
    const customer = object.key.split('/')[1];
    if (!byCustomer.has(customer)) byCustomer.set(customer, []);
    byCustomer.get(customer).push(object);
  }
  const agreementRows = [...byCustomer.entries()]
    .map(([customer, objects]) => {
      const groups = groupAgreementFiles(objects)
        .map((g) => {
          const head = `<div class="group-head"><strong>${esc(g.title)}</strong>${g.signedOn ? ` <span class="muted">· signed ${esc(g.signedOn)}</span>` : ''}</div>`;
          return `<div class="group">${head}${g.files.map((o) => fileLink(o, true)).join('')}</div>`;
        })
        .join('');
      return `<tr><td><code>${esc(customer)}</code></td><td>${groups}</td></tr>`;
    })
    .join('');

  const notice = url.searchParams.get('done');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>APEX Feeds documents</title>
<style>
:root{--moss:#333832;--stone:#faf9f7;--line:rgb(51 56 50/.18);--amber:#e2a13b}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--moss);background:var(--stone)}
main{max-width:1000px;margin:0 auto;padding:32px 16px 80px}h1{font-size:28px;margin:0 0 4px}h2{font-size:20px;margin:40px 0 12px}
.muted{opacity:.7;font-size:14px}.card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:20px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:16px;overflow:hidden}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top;font-size:14px}th{background:#f1efea}
.file{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:2px 0}.file a{color:inherit}
form.inline{display:inline}button{font:inherit;border:1px solid var(--moss);background:var(--moss);color:#fff;border-radius:999px;padding:8px 18px;cursor:pointer}
button.link{background:none;color:#a33;border:0;padding:0;text-decoration:underline;font-size:13px}
label{display:block;font-weight:600;font-size:14px;margin:12px 0 4px}input{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;width:100%;max-width:420px}
.ok{background:#e6f2e2;border-radius:12px;padding:10px 14px;margin:16px 0}
.group+.group{margin-top:12px;padding-top:12px;border-top:1px dashed var(--line)}
</style></head><body><main>
<h1>APEX Feeds documents</h1><p class="muted">Signed in as ${esc(admin.email)}. Files here are private: only people allowed through Cloudflare Access can open them.</p>
${notice ? `<p class="ok">${esc(notice)}</p>` : ''}
<h2>Upload a signed wholesale agreement</h2>
<div class="card"><form method="post" action="/admin/agreements" enctype="multipart/form-data">
<label for="customer">Customer ID</label><input id="customer" name="customer" inputmode="numeric" pattern="[0-9]{4,20}" required placeholder="e.g. 8471234567890">
<p class="muted">Open the customer in Shopify admin. The ID is the number at the end of the page address.</p>
<label for="title">Title shown to the customer</label><input id="title" name="title" maxlength="80" placeholder="Wholesale agreement 2026">
<label for="signed">Date signed</label><input id="signed" name="signed" type="date">
<p class="muted">Optional. The customer sees "Signed" and this date on their account.</p>
<label for="file">Signed agreement files</label><input id="file" name="file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" multiple required>
<p class="muted">Pick the full agreement PDF and the photo or scan of the signed page together (hold Ctrl or Cmd to select more than one). PDF, JPG, PNG or WEBP, up to ${MAX_FILES_PER_AGREEMENT} files, 10 MB each.</p>
<p><button type="submit">Upload agreement</button></p></form></div>
<h2>Agreements by customer</h2>
${agreementRows ? `<table><thead><tr><th>Customer ID</th><th>Files</th></tr></thead><tbody>${agreementRows}</tbody></table>` : '<p class="muted">No agreements uploaded yet.</p>'}
<h2>Application documents</h2>
<p class="muted">Each application's email includes its reference, so you can match the files to the application.</p>
${appRows ? `<table><thead><tr><th>Date</th><th>Reference</th><th>Files</th></tr></thead><tbody>${appRows}</tbody></table>` : '<p class="muted">No application documents yet.</p>'}
</main></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } });
}

function fileLink(object, deletable = false) {
  const meta = object.customMetadata || {};
  const name = (object.key.startsWith('agreements/') ? meta.label : meta.title || meta.label) || meta.title || object.key.split('/').pop();
  const href = `/admin/file?key=${encodeURIComponent(object.key)}`;
  const del = deletable
    ? `<form class="inline" method="post" action="/admin/delete" onsubmit="return confirm('Delete this file for good?')"><input type="hidden" name="key" value="${esc(object.key)}"><button class="link" type="submit">Delete</button></form>`
    : '';
  return `<div class="file"><a href="${href}" target="_blank" rel="noopener">${esc(name)}</a><span class="muted">${esc(meta.originalName || '')} · ${Math.ceil(object.size / 1024)} KB</span>${del}</div>`;
}

async function adminUploadAgreement(request, env) {
  const form = await readForm(request);
  const customer = String(form.get('customer') || '').trim();
  if (!/^\d{4,20}$/.test(customer)) throw new HttpError(400, 'Customer ID should be the number from the customer page address');
  const files = form.getAll('file').filter((f) => f && typeof f !== 'string' && f.size > 0);
  if (!files.length) throw new HttpError(400, 'No file received');
  if (files.length > MAX_FILES_PER_AGREEMENT) throw new HttpError(400, `Upload up to ${MAX_FILES_PER_AGREEMENT} files per agreement`);
  // Check every file before storing any, so a bad file doesn't leave half an agreement behind.
  const checked = [];
  for (const file of files) checked.push({ file, ...(await checkFile(file, AGREEMENT_TYPES)) });
  await guardStorage(env, await bucketUsage(env), checked.reduce((sum, c) => sum + c.bytes.byteLength, 0));

  const title = cleanText(form.get('title'), 80) || 'Wholesale agreement';
  const signedRaw = String(form.get('signed') || '').trim();
  const signedOn = /^\d{4}-\d{2}-\d{2}$/.test(signedRaw) && !Number.isNaN(Date.parse(signedRaw)) ? signedRaw : '';
  const stamp = String(Date.now());
  const uploadedAt = new Date().toISOString();
  let pdfs = 0;
  let images = 0;
  for (const [i, c] of checked.entries()) {
    const isPdf = c.type === 'application/pdf';
    const n = isPdf ? ++pdfs : ++images;
    const label = isPdf ? (n > 1 ? `Agreement (PDF ${n})` : 'Agreement (PDF)') : n > 1 ? `Signed page ${n}` : 'Signed page';
    const key = `agreements/${customer}/${stamp}-${String(i + 1).padStart(2, '0')}-${safeName(c.file.name, c.ext)}`;
    await env.DOCS.put(key, c.bytes, {
      httpMetadata: { contentType: c.type },
      customMetadata: { title, label, signedOn, group: stamp, originalName: cleanText(c.file.name, 120), uploadedAt },
    });
  }
  const count = checked.length === 1 ? '1 file' : `${checked.length} files`;
  return redirect(`/admin?done=${encodeURIComponent(`Uploaded "${title}" (${count}) for customer ${customer}.`)}`);
}

// One agreement = the files uploaded together. Keys are agreements/<customer>/<stamp>-..., so the
// stamp groups them (older single-PDF uploads are a group of one). Newest first.
function groupAgreementFiles(objects) {
  const groups = new Map();
  for (const o of objects) {
    const stamp = o.key.split('/')[2].split('-')[0];
    if (!groups.has(stamp)) groups.set(stamp, []);
    groups.get(stamp).push(o);
  }
  return [...groups.entries()]
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .map(([stamp, files]) => {
      files.sort((a, b) => (a.key < b.key ? -1 : 1));
      const meta = files[0].customMetadata || {};
      return {
        stamp,
        title: meta.title || 'Wholesale agreement',
        signedOn: meta.signedOn || '',
        uploadedAt: meta.uploadedAt || files[0].uploaded,
        files,
      };
    });
}

async function adminDelete(request, env) {
  const form = await readForm(request);
  const key = String(form.get('key') || '');
  if (!/^(agreements|applications)\//.test(key) || key.includes('..')) throw new HttpError(400, 'Unknown file');
  await env.DOCS.delete(key);
  return redirect(`/admin?done=${encodeURIComponent('File deleted.')}`);
}

// ---------------------------------------------------------------- agreements for the logged-in customer

async function listAgreements(env, customerId, url) {
  if (!env.DOWNLOAD_SECRET) throw new HttpError(503, 'Agreements are not switched on yet');
  const objects = await listAll(env, `agreements/${customerId}/`);
  const exp = Math.floor(Date.now() / 1000) + DOWNLOAD_LINK_SECONDS;
  const base = publicUrl(env) || url.origin;
  const link = async (o) => `${base}/d/${encodeURIComponent(o.key)}?exp=${exp}&sig=${await hmacHex(env.DOWNLOAD_SECRET, `${o.key}|${exp}`)}`;
  return Promise.all(
    groupAgreementFiles(objects).map(async (g) => {
      const files = await Promise.all(
        g.files.map(async (o) => ({
          label: o.customMetadata?.label || 'Agreement (PDF)',
          type: o.httpMetadata?.contentType || 'application/pdf',
          size: o.size,
          url: await link(o),
        }))
      );
      return {
        title: g.title,
        signed: true,
        signedOn: g.signedOn || null,
        uploadedAt: g.uploadedAt,
        expiresAt: exp,
        files,
        // First file, kept for older callers.
        size: files[0].size,
        url: files[0].url,
      };
    })
  );
}

async function verifyDownloadLink(env, key, exp, sig) {
  if (!key || !exp || !sig || !/^agreements\//.test(key)) throw new HttpError(404, 'Not found');
  if (Number(exp) < Math.floor(Date.now() / 1000)) throw new HttpError(410, 'This link has expired. Open it again from your account.');
  const expected = await hmacHex(env.DOWNLOAD_SECRET, `${key}|${exp}`);
  if (!timingSafeEqual(expected, sig)) throw new HttpError(403, 'Invalid link');
}

// Shopify app proxy: https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
async function verifyAppProxy(url, env) {
  const params = new Map();
  for (const [key, value] of url.searchParams) {
    if (!params.has(key)) params.set(key, []);
    params.get(key).push(value);
  }
  const signature = params.get('signature')?.[0];
  if (!signature) throw new HttpError(401, 'Unsigned request');
  params.delete('signature');
  const message = [...params.keys()].sort().map((k) => `${k}=${params.get(k).join(',')}`).join('');
  const expected = await hmacHex(env.SHOPIFY_API_SECRET, message);
  if (!timingSafeEqual(expected, signature)) throw new HttpError(401, 'Bad signature');
  if (env.SHOPIFY_SHOP && params.get('shop')?.[0] !== env.SHOPIFY_SHOP) throw new HttpError(401, 'Wrong shop');
  const timestamp = Number(params.get('timestamp')?.[0]);
  if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > PROXY_MAX_AGE_SECONDS) throw new HttpError(401, 'Request too old');
  const customer = params.get('logged_in_customer_id')?.[0];
  if (!customer || !/^\d+$/.test(customer)) throw new HttpError(401, 'Please log in to see your agreements');
  return customer;
}

// Customer account UI extension session token (HS256, signed with the app's client secret).
async function verifySessionToken(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Missing session token');
  const [h, p, s] = parts;
  const head = JSON.parse(b64urlText(h));
  if (head.alg !== 'HS256') throw new HttpError(401, 'Bad token');
  const key = await hmacKey(env.SHOPIFY_API_SECRET);
  const ok = await crypto.subtle.verify('HMAC', key, b64urlBytes(s), enc(`${h}.${p}`));
  if (!ok) throw new HttpError(401, 'Bad token');
  const payload = JSON.parse(b64urlText(p));
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now - 5) throw new HttpError(401, 'Token expired');
  if (payload.nbf && payload.nbf > now + 5) throw new HttpError(401, 'Token not yet valid');
  if (env.SHOPIFY_API_KEY && payload.aud !== env.SHOPIFY_API_KEY) throw new HttpError(401, 'Wrong app');
  if (env.SHOPIFY_SHOP && payload.dest && !String(payload.dest).includes(env.SHOPIFY_SHOP)) throw new HttpError(401, 'Wrong shop');
  const match = /^gid:\/\/shopify\/Customer\/(\d+)$/.exec(String(payload.sub || ''));
  if (!match) throw new HttpError(401, 'No customer in token');
  return match[1];
}

// Cloudflare Access token (RS256): https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
let certCache = { at: 0, keys: [] };
async function verifyAccessJwt(token, env) {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) throw new HttpError(401, 'Bad sign-in token');
  const head = JSON.parse(b64urlText(h));
  if (head.alg !== 'RS256') throw new HttpError(401, 'Bad sign-in token');
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new HttpError(500, 'Cloudflare Access is not set up yet');
  if (Date.now() - certCache.at > 3600_000 || !certCache.keys.some((k) => k.kid === head.kid)) {
    const res = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    certCache = { at: Date.now(), keys: (await res.json()).keys || [] };
  }
  const jwk = certCache.keys.find((k) => k.kid === head.kid);
  if (!jwk) throw new HttpError(401, 'Unknown sign-in key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(s), enc(`${h}.${p}`));
  if (!ok) throw new HttpError(401, 'Bad sign-in token');
  const payload = JSON.parse(b64urlText(p));
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(env.ACCESS_AUD)) throw new HttpError(401, 'Sign-in token is for another app');
  if (payload.exp < Date.now() / 1000) throw new HttpError(401, 'Sign-in expired');
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) throw new HttpError(401, 'Bad sign-in issuer');
  return payload;
}

// ---------------------------------------------------------------- helpers

async function streamFile(env, key, download) {
  if (!key || !/^(agreements|applications)\//.test(key) || key.includes('..')) throw new HttpError(404, 'Not found');
  const object = await env.DOCS.get(key);
  if (!object) throw new HttpError(404, 'Not found');
  const name = object.customMetadata?.originalName || key.split('/').pop();
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
}

async function bucketUsage(env) {
  const objects = [];
  let cursor;
  do {
    const page = await env.DOCS.list({ cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && objects.length < 20000);
  return { objects, bytes: objects.reduce((sum, o) => sum + o.size, 0) };
}

async function guardStorage(env, usage, incomingBytes) {
  const limit = numberVar(env.STORAGE_LIMIT_GB, DEFAULT_STORAGE_LIMIT_GB) * 1024 ** 3;
  if (usage.bytes + incomingBytes > limit) {
    throw new HttpError(507, 'Document storage is full. Please email us your documents instead.');
  }
}

function numberVar(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function listAll(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.DOCS.list({ prefix, cursor, include: ['customMetadata', 'httpMetadata'] });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && out.length < 5000);
  return out;
}

async function readForm(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BYTES + 64 * 1024) throw new HttpError(413, 'Files must be 10 MB or smaller');
  try {
    return await request.formData();
  } catch {
    throw new HttpError(400, 'Could not read the upload');
  }
}

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const redirect = (location) => new Response(null, { status: 303, headers: { Location: location } });
function withHeaders(response, headers) {
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries(headers)) r.headers.set(k, v);
  return r;
}
const list = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
const publicUrl = (env) => String(env.PUBLIC_URL || '').replace(/\/+$/, '');
const ascii = (b, start, len) => String.fromCharCode(...b.slice(start, start + len));
const enc = (s) => new TextEncoder().encode(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cleanText = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'file';
function safeName(name, ext) {
  const base = String(name || 'file').replace(/\.[^.]*$/, '');
  return `${slug(base)}.${ext}`;
}
function cookie(request, name) {
  const match = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : '';
}
async function hmacKey(secret) {
  if (!secret) throw new HttpError(500, 'Service is missing a secret');
  return crypto.subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function hmacHex(secret, message) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function b64urlBytes(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const b64urlText = (s) => new TextDecoder().decode(b64urlBytes(s));
