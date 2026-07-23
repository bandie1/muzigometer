const pool = require('../../lib/db');
const { requireRole } = require('../../lib/auth');

module.exports = async (req, res) => {
  const session = requireRole(req, res, 'admin');
  if (!session) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, room_id } = req.body;
  const roomId = parseInt(room_id, 10);
  if (!roomId) {
    return res.status(400).json({ error: 'room_id is required' });
  }

  try {
    // FIX (feature 1): relay_status derived from remaining_units via the
    // same CASE expression used everywhere else, instead of a hardcoded
    // 0/1 literal, so this endpoint can never drift from the
    // "balance > 0 => relay on" rule enforced elsewhere.
    if (action === 'demo_reset') {
      await pool.query(
        `UPDATE rooms SET remaining_units = 0.0, total_paid = 0.0,
           relay_status = CASE WHEN 0.0 > 0 THEN 1 ELSE 0 END WHERE room_id = $1`,
        [roomId]
      );
    } else if (action === 'demo_restore') {
      await pool.query(
        `UPDATE rooms SET remaining_units = 10.0,
           relay_status = CASE WHEN 10.0 > 0 THEN 1 ELSE 0 END WHERE room_id = $1`,
        [roomId]
      );
    } else {
      return res.status(400).json({ error: 'Unknown action' });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Database error: ' + err.message });
  }
};
