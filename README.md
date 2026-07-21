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
    admin-action.js       -> POST, handles Reset/Force Restore buttons (admin, any room)
    landlord.js            -> GET, JSON data scoped to the logged-in landlord's own rooms (no PZEM)
    landlord-action.js     -> POST, Reset/Force Restore, scoped to the landlord's own rooms
    tenant.js               -> GET, read-only JSON for the logged-in tenant's own room (no PZEM)
    buy-units.js            -> POST, tenant submits a top-up ("Buy Units") request
    approve-request.js      -> POST, admin approves/rejects a pending top-up request
lib/
  db.js                  -> shared Postgres pool
  auth.js                -> JWT cookie helpers
public/
  login.html
  signup.html             -> landlord/tenant registration form
  forgot-password.html    -> username + new password reset form
  admin-dashboard.html    -> landlords grouped into collapsible drawers, each holding its
                             rooms with LIVE PZEM readings (admin-only), plus a pending
                             top-up approvals panel
  landlord-dashboard.html -> portfolio summary + own rooms, with Reset/Force Restore
                             (no PZEM readings — admin dashboard only)
  tenant-dashboard.html   -> balance, payment history, and a "Buy Units" flow
                             (no PZEM readings — admin dashboard only)
```

All dashboards and forms are fully responsive (mobile, tablet, desktop breakpoints).

## Behavior notes

- **PZEM sensor readings are admin-only.** The landlord and tenant dashboards/APIs no
  longer fetch or display live voltage/current/power/etc — only balance, payment, and
  online/cut-off status. Only `api/dashboard/admin.js` queries `energy_logs`.
- **Readings are strictly live, never stale/stored.** `admin.js` computes `conn_state`
  (`live` within 15s / `stale` / `none`) exactly as before, but now whenever a room isn't
  actively reporting (`stale` or `none`), every numeric PZEM value is zeroed out in the
  API response rather than showing the last value written to `energy_logs`.
- **Buy Units flow.** A tenant taps "Buy Units", enters a UGX amount, and the page (a)
  calls `POST /api/dashboard/buy-units` to create a `pending` row in a new
  `purchase_requests` table, and (b) opens the phone's dialer via a `tel:` link with a
  USSD payment code (`USSD_TEMPLATE` in `tenant-dashboard.html` — replace with your real
  mobile-money short-code). The admin dashboard shows all pending requests up top;
  approving one adds the stored `units`/`amount` to that room's `remaining_units` /
  `total_paid` and turns the relay back on; rejecting just marks it `rejected`. The
  tariff (`UGX_PER_KWH`, currently 700) lives in `api/dashboard/buy-units.js` — adjust it
  there to match your pricing.
- **Drawers on the admin dashboard.** Landlords render as collapsible drawers (closed by
  default); expanding one reveals only that landlord's rooms/tenants, so the page no
  longer shows one long flat list. Open/closed state persists across the 4s poll.
- **Sync.** All three dashboards poll their respective (now role-scoped) endpoints every
  4 seconds, so admin actions (reset/restore/approve) and tenant top-ups show up on the
  other dashboards within one poll cycle without a manual refresh.

## Required SQL

Run this in the Supabase SQL editor in addition to the `energy_logs` constraints
mentioned below — it backs the new "Buy Units" approval flow:

```sql
CREATE TABLE IF NOT EXISTS purchase_requests (
  id BIGSERIAL PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(room_id),
  tenant_id INTEGER NOT NULL REFERENCES users(id),
  amount NUMERIC NOT NULL,
  units NUMERIC NOT NULL,
  ussd_reference TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_purchase_requests_room ON purchase_requests(room_id);
CREATE INDEX IF NOT EXISTS idx_purchase_requests_status ON purchase_requests(status);
```

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
