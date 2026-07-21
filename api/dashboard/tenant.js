const pool = require('../../lib/db');
const { requireRole } = require('../../lib/auth');

module.exports = async (req, res) => {
  const session = requireRole(req, res, 'tenant');
  if (!session) return; // requireRole already sent a 401

  try {
    if (!session.room_id) {
      return res.status(200).json({ room: null });
    }

    const roomRes = await pool.query('SELECT * FROM rooms WHERE room_id = $1', [session.room_id]);
    const room = roomRes.rows[0];
    if (!room) {
      return res.status(200).json({ room: null });
    }

    const telemetryRes = await pool.query(
      'SELECT * FROM energy_logs WHERE room_id = $1 ORDER BY logged_at DESC LIMIT 1',
      [session.room_id]
    );
    const t = telemetryRes.rows[0];
    let telemetry = { conn_state: 'none' };
    if (t) {
      const ageSeconds = t.logged_at ? (Date.now() - new Date(t.logged_at).getTime()) / 1000 : Infinity;
      telemetry = { ...t, conn_state: ageSeconds > 15 ? 'stale' : 'live' };
    }

    return res.status(200).json({ room: { ...room, telemetry } });
  } catch (err) {
    return res.status(500).json({ error: 'Database error: ' + err.message });
  }
};
