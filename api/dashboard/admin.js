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
      SELECT u.id AS tenant_id, u.username AS tenant_name, r.room_id, r.room_name,
             r.remaining_units, r.last_amount_paid, r.total_paid,
             l.id AS landlord_id, l.username AS landlord_name
      FROM users u
      JOIN rooms r ON u.room_id = r.room_id
      JOIN users l ON r.landlord_id = l.id
      WHERE u.role = 'tenant'
      ORDER BY l.username ASC, r.room_name ASC
    `);

    const tenantsByLandlord = {};
    const tenantNameByRoom = {};
    for (const row of tenantsRes.rows) {
      if (!tenantsByLandlord[row.landlord_id]) tenantsByLandlord[row.landlord_id] = [];
      tenantsByLandlord[row.landlord_id].push(row);
      tenantNameByRoom[row.room_id] = row.tenant_name;
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

    // Pre-compute connection state server-side: 'live' within 15s AND the
    // device reported the PZEM as actually online, 'sensor_offline' if the
    // device is reporting but says the PZEM itself isn't answering, 'stale'
    // if the device has stopped reporting altogether, 'none' if the room has
    // never reported. Readings are LIVE ONLY — in every non-live case, every
    // numeric value is zeroed out rather than showing the last stored
    // reading.
    const telemetryByRoom = {};
    for (const row of telemetryRes.rows) {
      const ageSeconds = row.logged_at ? (Date.now() - new Date(row.logged_at).getTime()) / 1000 : Infinity;
      const isFresh = ageSeconds <= 15;
      let conn_state;
      if (!isFresh) conn_state = 'stale';
      else if (!row.pzem_online) conn_state = 'sensor_offline';
      else conn_state = 'live';

      const isLive = conn_state === 'live';
      telemetryByRoom[row.room_id] = {
        conn_state,
        logged_at: row.logged_at,
        voltage: isLive ? row.voltage : 0,
        current: isLive ? row.current : 0,
        power: isLive ? row.power : 0,
        energy: isLive ? row.energy : 0,
        frequency: isLive ? row.frequency : 0,
        power_factor: isLive ? row.power_factor : 0,
      };
    }

    // Attach a 'none' placeholder for rooms with no energy_logs row at all,
    // so the frontend never has to guess — it always gets an explicit state.
    const rooms = roomsRes.rows.map((room) => ({
      ...room,
      tenant_name: tenantNameByRoom[room.room_id] || null,
      telemetry: telemetryByRoom[room.room_id] || {
        conn_state: 'none', voltage: 0, current: 0, power: 0, energy: 0, frequency: 0, power_factor: 0,
      },
    }));

    // Pending top-up ("buy units") requests awaiting admin approval.
    const pendingRes = await pool.query(`
      SELECT pr.id, pr.amount, pr.units, pr.created_at, pr.room_id,
             u.username AS tenant_name, r.room_name, l.id AS landlord_id, l.username AS landlord_name
      FROM purchase_requests pr
      JOIN users u ON pr.tenant_id = u.id
      JOIN rooms r ON pr.room_id = r.room_id
      JOIN users l ON r.landlord_id = l.id
      WHERE pr.status = 'pending'
      ORDER BY pr.created_at ASC
    `);

    return res.status(200).json({
      landlords: landlordsRes.rows,
      tenants_by_landlord: tenantsByLandlord,
      rooms,
      pending_requests: pendingRes.rows,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Database error: ' + err.message });
  }
};
