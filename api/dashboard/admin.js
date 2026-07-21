const pool = require('../../lib/db');
const { requireRole } = require('../../lib/auth');

module.exports = async (req, res) => {
  const session = requireRole(req, res, 'admin');
  if (!session) return; // requireRole already sent a 401

  try {
    const landlordsRes = await pool.query(
      "SELECT id AS user_id, username FROM users WHERE role = 'landlord' ORDER BY username ASC"
    );

    const tenantsRes = await pool.query(`
      SELECT u.username AS tenant_name, r.room_name, r.remaining_units, r.last_amount_paid, r.total_paid,
             l.id AS landlord_id, l.username AS landlord_name
      FROM users u
      JOIN rooms r ON u.room_id = r.room_id
      JOIN users l ON r.landlord_id = l.id
      WHERE u.role = 'tenant'
      ORDER BY l.username ASC, r.room_name ASC
    `);

    const tenantsByLandlord = {};
    for (const row of tenantsRes.rows) {
      if (!tenantsByLandlord[row.landlord_id]) tenantsByLandlord[row.landlord_id] = [];
      tenantsByLandlord[row.landlord_id].push(row);
    }

    const roomsRes = await pool.query('SELECT * FROM rooms ORDER BY room_name ASC');

    const telemetryRes = await pool.query(`
      SELECT e1.* FROM energy_logs e1
      INNER JOIN (
        SELECT room_id, MAX(logged_at) AS max_logged_at
        FROM energy_logs
        GROUP BY room_id
      ) e2 ON e1.room_id = e2.room_id AND e1.logged_at = e2.max_logged_at
    `);

    // Pre-compute connection state server-side (mirrors the original PHP
    // logic exactly): 'live' within 15s, 'stale' if older, 'none' if the
    // room has never reported.
    const telemetryByRoom = {};
    for (const row of telemetryRes.rows) {
      const ageSeconds = row.logged_at ? (Date.now() - new Date(row.logged_at).getTime()) / 1000 : Infinity;
      telemetryByRoom[row.room_id] = {
        ...row,
        conn_state: ageSeconds > 15 ? 'stale' : 'live',
      };
    }

    // Attach a 'none' placeholder for rooms with no energy_logs row at all,
    // so the frontend never has to guess — it always gets an explicit state.
    const rooms = roomsRes.rows.map((room) => ({
      ...room,
      telemetry: telemetryByRoom[room.room_id] || { conn_state: 'none' },
    }));

    return res.status(200).json({
      landlords: landlordsRes.rows,
      tenants_by_landlord: tenantsByLandlord,
      rooms,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Database error: ' + err.message });
  }
};
