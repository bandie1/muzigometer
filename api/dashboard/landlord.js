const pool = require('../../lib/db');
const { requireRole } = require('../../lib/auth');

module.exports = async (req, res) => {
  const session = requireRole(req, res, 'landlord');
  if (!session) return; // requireRole already sent a 401

  try {
    const roomsRes = await pool.query(
      'SELECT * FROM rooms WHERE landlord_id = $1 ORDER BY room_name ASC',
      [session.user_id]
    );

    const tenantsRes = await pool.query(
      `SELECT u.username AS tenant_name, r.room_id, r.room_name
       FROM users u
       JOIN rooms r ON u.room_id = r.room_id
       WHERE u.role = 'tenant' AND r.landlord_id = $1`,
      [session.user_id]
    );
    const tenantByRoom = {};
    for (const row of tenantsRes.rows) tenantByRoom[row.room_id] = row.tenant_name;

    const roomIds = roomsRes.rows.map((r) => r.room_id);
    let telemetryByRoom = {};
    if (roomIds.length > 0) {
      const placeholders = roomIds.map((_, i) => `$${i + 1}`).join(',');
      const telemetryRes = await pool.query(
        `SELECT e1.* FROM energy_logs e1
         INNER JOIN (
           SELECT room_id, MAX(logged_at) AS max_logged_at
           FROM energy_logs
           WHERE room_id IN (${placeholders})
           GROUP BY room_id
         ) e2 ON e1.room_id = e2.room_id AND e1.logged_at = e2.max_logged_at`,
        roomIds
      );
      for (const row of telemetryRes.rows) {
        const ageSeconds = row.logged_at ? (Date.now() - new Date(row.logged_at).getTime()) / 1000 : Infinity;
        telemetryByRoom[row.room_id] = { ...row, conn_state: ageSeconds > 15 ? 'stale' : 'live' };
      }
    }

    const rooms = roomsRes.rows.map((room) => ({
      ...room,
      tenant_name: tenantByRoom[room.room_id] || null,
      telemetry: telemetryByRoom[room.room_id] || { conn_state: 'none' },
    }));

    return res.status(200).json({ rooms });
  } catch (err) {
    return res.status(500).json({ error: 'Database error: ' + err.message });
  }
};
