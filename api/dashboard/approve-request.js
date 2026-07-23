const pool = require('../../lib/db');
const { requireRole } = require('../../lib/auth');

module.exports = async (req, res) => {
  const session = requireRole(req, res, 'admin');
  if (!session) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { request_id, decision } = req.body; // decision: 'approve' | 'reject'
  const id = parseInt(request_id, 10);
  if (!id) return res.status(400).json({ error: 'request_id is required' });
  if (decision !== 'approve' && decision !== 'reject') {
    return res.status(400).json({ error: 'decision must be approve or reject' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const reqRes = await client.query(
      "SELECT * FROM purchase_requests WHERE id = $1 AND status = 'pending' FOR UPDATE",
      [id]
    );
    const request = reqRes.rows[0];
    if (!request) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Request not found or already processed.' });
    }

    if (decision === 'approve') {
      // FIX (feature 1): relay state must always be a pure function of the
      // balance, never hardcoded independently of it. Hardcoding relay=1
      // here could theoretically re-energize a relay for an instant even
      // if remaining_units nets out to 0 (e.g. a concurrent consumption
      // deduction landed between request creation and approval). Deriving
      // it in the same UPDATE keeps this endpoint, admin-action,
      // landlord-action, and the telemetry auto-deduction path all
      // enforcing the exact same rule: balance > 0 => relay on.
      await client.query(
        `UPDATE rooms
         SET remaining_units = remaining_units + $1,
             total_paid = total_paid + $2,
             last_amount_paid = $2,
             relay_status = CASE WHEN (remaining_units + $1) > 0 THEN 1 ELSE 0 END
         WHERE room_id = $3`,
        [request.units, request.amount, request.room_id]
      );
      await client.query(
        "UPDATE purchase_requests SET status = 'approved', decided_at = now() WHERE id = $1",
        [id]
      );
    } else {
      await client.query(
        "UPDATE purchase_requests SET status = 'rejected', decided_at = now() WHERE id = $1",
        [id]
      );
    }

    await client.query('COMMIT');
    return res.status(200).json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Database error: ' + err.message });
  } finally {
    client.release();
  }
};
