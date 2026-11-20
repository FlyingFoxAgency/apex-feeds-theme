# APEX Feeds private document service: setup

This small service keeps wholesale documents in a **private** Cloudflare storage folder (R2).
Nothing in the folder is public. Files can only be opened through:

- **James's admin page** (`/admin`), behind a Cloudflare Access sign-in (a one-time code is emailed to him).
- **Short-lived links** (10 minutes) handed to a logged-in wholesaler for their own agreements only. That part is switched on later with the account dashboard work.

What it does today:

1. The wholesale application form uploads the shopfront photo, store interior photo and licences here.
   The application email James receives has a private link to each file plus an application reference.
2. James opens those links (Cloudflare asks him to sign in first), or browses everything on `/admin`.
3. On `/admin` James uploads each wholesaler's signed agreement (PDF) against their Shopify customer ID.

Everything is on Cloudflare's free plan. R2's free allowance is 10 GB of storage, far more than this needs.

---

## Part 1: Create the storage and the service (about 10 minutes)

1. Sign up at **dash.cloudflare.com** (free). Ideally use an Apex Feeds email so James owns it.
2. Left menu: **Storage & databases** > **R2 Object Storage**. Cloudflare asks for a card to turn R2 on. This is normal; usage stays inside the free allowance.
3. **Create bucket** with the name `apex-wholesale-docs`. Leave **Public access off** (the default). Don't connect a custom domain or r2.dev URL to it.
4. Left menu: **Compute** > **Workers & Pages** > **Create** > **Start with Hello World!**. Name it `apex-wholesale-docs` and click **Deploy**.
5. Click **Edit code**. Replace everything in the editor with the contents of `src/index.js`, then click **Deploy**.
6. Go to the Worker's **Settings**:
   - **Bindings** > **Add** > **R2 bucket**: variable name `DOCS`, bucket `apex-wholesale-docs`.
   - **Variables and Secrets** > add these as **Text**:
     - `ALLOWED_ORIGINS` = `https://apex-feeds-dev.myshopify.com` (when the real domain is live, add it with a comma, e.g. `https://apex-feeds-dev.myshopify.com,https://apexfeeds.com.au,https://www.apexfeeds.com.au`)
     - `PUBLIC_URL` = the Worker's address shown at the top of its page, e.g. `https://apex-wholesale-docs.<your-name>.workers.dev`
     - `ADMIN_EMAILS` = the email address(es) allowed on the admin page, comma separated
7. Copy the Worker's address. You'll need it in Part 3.

## Part 2: Lock the admin page with Cloudflare Access (about 10 minutes)

1. Left menu: **Zero Trust**. Pick a team name (this gives a team domain like `apexfeeds.cloudflareaccess.com`) and choose the **Free** plan.
2. **Access** > **Applications** > **Add an application** > **Self-hosted**.
   - Application domain: the Worker's address (without https://), **Path**: `admin`
   - Policy: **Allow**, Include **Emails** = the same address(es) as `ADMIN_EMAILS`.
   - Login method: **One-time PIN**.
3. After saving, open the application and copy its **Application Audience (AUD) Tag**.
4. Back in the Worker's **Variables and Secrets**, add as **Text**:
   - `ACCESS_TEAM_DOMAIN` = your team domain, e.g. `apexfeeds.cloudflareaccess.com`
   - `ACCESS_AUD` = the AUD tag
5. Test it: open `<worker address>/admin`. You should get a sign-in screen, then an email code, then the admin page.
   Open `<worker address>/upload` in a private window: it should say uploads are only accepted from the Apex Feeds website.

> If Access won't accept the workers.dev address in step 2, give the Worker a custom domain such as
> `docs.apexfeeds.com.au` (Worker > Settings > Domains & Routes). That needs the domain's DNS on Cloudflare.
> Then use that address everywhere above.

## Part 3: Turn uploads on in the theme (1 minute)

Theme editor > the Wholesale application page > **APEX wholesale form** section >
**Document upload service address** = `<worker address>/upload`. Save.

Leave it blank to go back to asking for links.

---

## Uploading a signed agreement (James)

> **Not needed any more (19 Nov 2026).** James decided the Retailer Agreement isn't signed per account: every wholesaler reads the same document at /pages/retailer-agreement. The upload form still works if he ever wants to keep a document against a customer.

On `/admin`, under **Upload a signed wholesale agreement**:

1. **Customer ID**: open the customer in Shopify admin; it's the number at the end of the page address.
2. **Title shown to the customer**, e.g. "Wholesale agreement 2026".
3. **Date signed** (optional). The wholesaler sees "Signed on <date>".
4. **Files**: select the full agreement PDF and the photo/scan of the signed page together
   (hold Ctrl or Cmd to pick more than one). PDF, JPG, PNG or WEBP; up to 6 files, 10 MB each.

Files uploaded together show as one agreement, on `/admin` and in the wholesaler's dashboard.

## Phase 2: wholesalers see their own agreements

> **Shelved (19 Nov 2026).** The theme no longer shows per-wholesaler agreements, so the APEX Docs app isn't needed. Kept here in case that changes.

The wholesale dashboard (/pages/wholesale > Terms and agreements) asks
`/apps/apex-docs/agreements` for the signed-in wholesaler's agreements. Shopify forwards that
address to this service and signs it with the customer's ID, so each wholesaler only ever gets
their own files, as 10-minute links. This needs one small private app, **APEX Docs**, with an
app proxy and nothing else. It's free (Shopify charges nothing for a private app, and it stays
on Cloudflare's free plan).

Installing apps on this store needs the store owner's ID verification first (same block as Appstle).

1. **Create the app.** On dev.shopify.com (signed in as the store owner, or a collaborator with
   app development rights), **Apps** > **Create app** > name it `APEX Docs`.
2. **Push its settings.** On a computer with the Shopify CLI, in the `shopify-app` folder:
   `shopify app config link` (pick APEX Docs; it fills in `client_id`), then `shopify app deploy`.
   This sets the app proxy: `apps` / `apex-docs` > `https://apex-wholesale-docs.apexfeeds.workers.dev/proxy`.
3. **Install it** on the store from the app's page in the Dev Dashboard (**Install app**, choose
   the APEX Feeds store).
4. **Give the service its secrets** (Worker > Settings > Variables and Secrets):
   - `SHOPIFY_API_SECRET` = the app's **Client secret** (Dev Dashboard > APEX Docs > Settings) as a **Secret**
   - `DOWNLOAD_SECRET` = any long random string, as a **Secret**
   - `SHOPIFY_SHOP` = `apex-feeds-dev.myshopify.com` (Text)
   - `SHOPIFY_API_KEY` = the app's **Client ID** (Text)
5. **Paste the latest `src/index.js`** into the Worker's code editor and **Deploy**.
6. **Test it:** signed in as a wholesale-tagged customer, open
   `https://apex-feeds-dev.myshopify.com/apps/apex-docs/agreements`. It should show
   `{"ok":true,"agreements":[...]}`. Signed out it says "Please log in to see your agreements".
7. **Switch it on in the theme:** theme editor > Wholesale page > APEX wholesale account section >
   tick **Show signed agreements**. Save.

If step 3 fails with a 500 error (a known Dev Dashboard issue for proxy-only apps), create the
app again with a new name and retry, or tell Claude.

`/ext/agreements` is also built, for a customer account extension (Shopify's own account pages).
The theme dashboard doesn't need it.

## Good to know

- **Removing files:** agreements have a Delete button on `/admin`. Application files can be deleted from the
  R2 bucket in the Cloudflare dashboard. Consider deleting documents from declined applications after a while.
- **Limits:** 10 MB per file; PDF, JPG, PNG, WEBP or HEIC only (checked from the file contents, not the name);
  up to 12 files per application.
- **Never outgrowing the free plan:** new uploads are refused once the folder holds 8 GB (R2's free allowance is 10 GB),
  and after 200 uploaded files in one day. Applicants then see a message asking them to email their documents.
  Change these with the optional Worker text variables `STORAGE_LIMIT_GB` and `DAILY_UPLOAD_LIMIT`.
- **Tests:** `npm install` then `npm test` runs 40 local checks (signatures, wrong customers, tampered links, file types).
