const pool = require('../../lib/db');
const { requireRole } = require('../../lib/auth');

// Commission taken by the platform on every unit purchase. Kept as a single
// constant so it always reflects current policy — applied to the UGX
// `amount` of every APPROVED purchase request (pending/rejected requests
// never became real revenue, so they're excluded from commission).
const COMMISSION_RATE = 0.02;

module.exports = async (req, res) => {
  const session = requireRole(req, res, 'admin');
  if (!session) return; // requireRole already sent a 401

  // The Statistics page asks for this endpoint with ?stats=1. The plain
  // overview poll (every 2s) never sets this, so it never pays for the
  // extra queries below — keeping this one route doing double duty instead
  // of adding a second serverless function (Vercel Hobby caps at 12).
  const wantsStats = req.query && (req.query.stats === '1' || req.query.stats === 'true');

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

    let stats;
    if (wantsStats) {
      // ---------- User analytics ----------
      // landlordsRes / tenantsRes above already give us the counts we need,
      // no extra query required.
      const totalLandlords = landlordsRes.rows.length;
      const totalTenants = tenantsRes.rows.length;
      const totalRooms = roomsRes.rows.length;
      const occupiedRooms = roomsRes.rows.filter((r) => tenantNameByRoom[r.room_id]).length;

      // ---------- Earnings analytics (needs its own queries) ----------
      const purchaseStatsRes = await pool.query(`
        SELECT status,
               COUNT(*)::int AS count,
               COALESCE(SUM(amount), 0)::float AS total_amount
        FROM purchase_requests
        GROUP BY status
      `);
      const byStatus = { pending: null, approved: null, rejected: null };
      for (const row of purchaseStatsRes.rows) byStatus[row.status] = row;
      const approvedAmount = byStatus.approved?.total_amount || 0;
      const pendingAmount = byStatus.pending?.total_amount || 0;
      const rejectedAmount = byStatus.rejected?.total_amount || 0;
      const totalCommission = approvedAmount * COMMISSION_RATE;

      const dailyEarningsRes = await pool.query(`
        SELECT DATE(decided_at) AS day, COALESCE(SUM(amount), 0)::float AS amount
        FROM purchase_requests
        WHERE status = 'approved' AND decided_at >= now() - interval '30 days'
        GROUP BY DATE(decided_at)
        ORDER BY day ASC
      `);
      const dailyEarnings = dailyEarningsRes.rows.map((r) => ({
        day: r.day,
        amount: r.amount,
        commission: r.amount * COMMISSION_RATE,
      }));

      const totalRevenue = roomsRes.rows.reduce((sum, r) => sum + (parseFloat(r.total_paid) || 0), 0);

      // ---------- System analytics — reuse rooms/telemetry, no new queries ----------
      const totalRemainingUnits = roomsRes.rows.reduce((sum, r) => sum + (parseFloat(r.remaining_units) || 0), 0);
      const activeTenants = rooms.filter((r) => r.relay_status == 1 && tenantNameByRoom[r.room_id]).length;

      let liveCount = 0, staleCount = 0, sensorOfflineCount = 0, noneCount = 0, totalEnergyUsed = 0;
      for (const room of rooms) {
        const state = room.telemetry.conn_state;
        if (state === 'live') liveCount++;
        else if (state === 'sensor_offline') sensorOfflineCount++;
        else if (state === 'stale') staleCount++;
        else noneCount++;
      }
      // energy is zeroed out for non-live rooms in `telemetryByRoom` (by design —
      // see the comment above), so sum the raw logs instead for a true total.
      for (const row of telemetryRes.rows) totalEnergyUsed += Number(row.energy) || 0;

      stats = {
        users: {
          total_landlords: totalLandlords,
          total_tenants: totalTenants,
          total_rooms: totalRooms,
          occupied_rooms: occupiedRooms,
          vacant_rooms: Math.max(totalRooms - occupiedRooms, 0),
        },
        earnings: {
          commission_rate: COMMISSION_RATE,
          total_commission: totalCommission,
          approved_amount: approvedAmount,
          net_to_landlords: approvedAmount - totalCommission,
          pending_amount: pendingAmount,
          rejected_amount: rejectedAmount,
          approved_count: byStatus.approved?.count || 0,
          pending_count: byStatus.pending?.count || 0,
          rejected_count: byStatus.rejected?.count || 0,
          total_revenue: totalRevenue,
          daily_earnings: dailyEarnings,
        },
        system: {
          total_remaining_units: totalRemainingUnits,
          total_energy_used: totalEnergyUsed,
          active_tenants: activeTenants,
          sensor_diagnostics: {
            live: liveCount,
            stale: staleCount,
            sensor_offline: sensorOfflineCount,
            none: noneCount,
          },
        },
      };
    }

    return res.status(200).json({
      landlords: landlordsRes.rows,
      tenants_by_landlord: tenantsByLandlord,
      rooms,
      pending_requests: pendingRes.rows,
      ...(stats ? { stats } : {}),
    });
  } catch (err) {
    return res.status(500).json({ error: 'Database error: ' + err.message });
  }
};
