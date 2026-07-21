# Mizigo Meter — Vercel + Supabase

## What changed vs the PHP version
- `$_SESSION` → signed JWT stored in an httpOnly cookie (`lib/auth.js`). Vercel functions are
  stateless, so there's no server-side session store — the token itself carries `user_id`,
  `username`, `role`, `room_id`, and is verified on every request.
- `mysqli`/PDO → `pg` (node-postgres) connection pool (`lib/db.js`).
- Dashboards are now **static HTML** (`public/*.html`) that fetch JSON from API routes and
  render client-side, polling every few seconds — this is what gives you live-updating PZEM
  readings without a page reload.
- The "no reading = no value" behavior is preserved exactly: `api/dashboard/admin.js` computes
  `conn_state` (`live` / `stale` / `none`) server-side using the same 15-second threshold as your
  original PHP, and the frontend shows "Not Connected" instead of fabricated numbers when a room
  has never reported.

## File map
```
api/
  login.js              -> POST, sets session cookie
  logout.js              -> POST, clears session cookie
  signup.js              -> POST, registers landlord/tenant
  forgot-password.js     -> POST, resets password
  telemetry.js           -> POST/GET, the ESP32 endpoint (no auth — device can't hold a cookie)
  dashboard/
    admin.js             -> GET, JSON data for admin dashboard (requires admin session)
    admin-action.js       -> POST, handles Reset/Force Restore buttons
lib/
  db.js                  -> shared Postgres pool
  auth.js                -> JWT cookie helpers
public/
  login.html
  admin-dashboard.html    -> full worked example
```

## Still to do (same pattern, not yet built)
`landlord-dashboard.html` + `api/dashboard/landlord.js`, `tenant-dashboard.html` +
`api/dashboard/tenant.js`, and `signup.html` / `forgot-password.html` (simple forms —
follow `login.html`'s fetch pattern, posting to `/api/signup` and `/api/forgot-password`).
Happy to build these next — just say the word.

## Deploy steps
1. **Push this folder to a GitHub repo** (Vercel deploys from Git).
   ```bash
   git init
   git add .
   git commit -m "Mizigo on Vercel"
   git remote add origin <your-repo-url>
   git push -u origin main
   ```
2. **Import the repo in Vercel** (vercel.com → Add New Project → import your repo).
3. **Set Environment Variables** in the Vercel project settings (Settings → Environment
   Variables) — use the names in `.env.example`:
   - `DB_HOST`, `DB_PORT` (use `6543`, the transaction pooler — best fit for serverless),
     `DB_NAME`, `DB_USER`, `DB_PASS` (raw password, not URL-encoded)
   - `JWT_SECRET` — generate with `openssl rand -base64 48`
4. **Deploy.** Vercel auto-detects `api/*.js` as serverless functions and serves `public/*.html`
   as static pages.
5. **Point your ESP32 firmware** at `https://your-project.vercel.app/api/telemetry` instead of
   the old `api.php` URL.
6. **Run the required SQL** in the Supabase SQL editor if you haven't already:
   ```sql
   ALTER TABLE energy_logs ADD CONSTRAINT unique_room UNIQUE (room_id);
   ALTER TABLE energy_logs ALTER COLUMN logged_at SET DEFAULT now();
   ```

## Testing locally
```bash
npm install -g vercel
npm install
vercel dev
```
`vercel dev` reads `.env.local` (copy from `.env.example`) and runs both the static files and
the API routes on `localhost:3000`, matching production behavior closely.
