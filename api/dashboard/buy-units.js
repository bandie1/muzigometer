const pool = require('../../lib/db');
const { requireRole } = require('../../lib/auth');

// Tariff used to convert a UGX payment into kWh units at request time.
// Adjust to match your actual pricing. Store the computed units alongside
// the request so a later tariff change never retroactively affects pending
// or historical requests.
const UGX_PER_KWH = 700;

// FIX (feature 3): correct per-network USSD templates, including the
// merchant/till codes — the old single hardcoded template was missing a
// merchant code entirely and had no MTN option. Built server-side (not
// trusted from the client) so the stored ussd_reference always matches
// the network the tenant actually selected.
const USSD_TEMPLATES = {
  mtn: (amount) => `*165*3*770376*${amount}#`,
  airtel: (amount) => `*185*9*1337749*${amount}#`,
};

module.exports = async (req, res) => {
  const session = requireRole(req, res, 'tenant');
  if (!session) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!session.room_id) {
    return res.status(400).json({ error: 'No room is assigned to your account yet.' });
  }

  const { amount, network } = req.body;
  const amountNum = parseFloat(amount);
  if (!amountNum || amountNum <= 0) {
    return res.status(400).json({ error: 'Enter a valid amount.' });
  }

  const networkKey = String(network || '').toLowerCase();
  const buildUssd = USSD_TEMPLATES[networkKey];
  if (!buildUssd) {
    return res.status(400).json({ error: 'Select a payment network (MTN or Airtel).' });
  }

  const ussdCode = buildUssd(Math.round(amountNum));
  const units = amountNum / UGX_PER_KWH;

  try {
    const result = await pool.query(
      `INSERT INTO purchase_requests (room_id, tenant_id, amount, units, ussd_reference, payment_network, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', now())
       RETURNING id, amount, units, status, created_at`,
      [session.room_id, session.user_id, amountNum, units, ussdCode, networkKey]
    );

    return res.status(200).json({
      message: 'Top-up request submitted. It will be added to your balance once approved.',
      request: result.rows[0],
      ussd_code: ussdCode,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Database error: ' + err.message });
  }
};
