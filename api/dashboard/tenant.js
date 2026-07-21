const pool = require('../../lib/db');
const { requireRole } = require('../../lib/auth');

// NOTE: PZEM sensor readings are intentionally NOT included here — live
// telemetry is shown on the admin dashboard only.
module.exports = async (req, res) => {
  const session = requireRole(req, res, 'tenant');
  if (!session) return; // requireRole already sent a 401

  try {
    if (!session.room_id) {
      return res.status(200).json({ room: null, latest_request: null });
    }

    const roomRes = await pool.query('SELECT * FROM rooms WHERE room_id = $1', [session.room_id]);
    const room = roomRes.rows[0] || null;

    const requestRes = await pool.query(
      `SELECT id, amount, units, status, created_at, decided_at
       FROM purchase_requests
       WHERE room_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [session.room_id]
    );
    const latestRequest = requestRes.rows[0] || null;

    return res.status(200).json({ room, latest_request: latestRequest });
  } catch (err) {
    return res.status(500).json({ error: 'Database error: ' + err.message });
  }
};
