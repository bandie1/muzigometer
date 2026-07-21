const pool = require('../../lib/db');
const { requireRole } = require('../../lib/auth');

// NOTE: PZEM sensor readings are intentionally NOT included here — live
// telemetry is shown on the admin dashboard only.
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

    const rooms = roomsRes.rows.map((room) => ({
      ...room,
      tenant_name: tenantByRoom[room.room_id] || null,
    }));

    return res.status(200).json({ rooms });
  } catch (err) {
    return res.status(500).json({ error: 'Database error: ' + err.message });
  }
};
