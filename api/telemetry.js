// api/telemetry.js — called directly by the ESP32 firmware.
// Point the device at:  https://your-project.vercel.app/api/telemetry
//
// This is the ONLY write path for PZEM data. The firmware no longer writes
// straight to Supabase's REST API — that second path had no device identity,
// no hierarchy check, and never touched `logged_at` on update, so rooms
// silently went "stale" while still reporting HTTP 200. One write path,
// one source of truth.
//
// Every request must carry:
//   headers: { "X-Device-Id": "...", "X-Device-Key": "..." }
// The device_id/device_key pair is resolved against the `devices` table
// (see sql/001_fix_data_pipeline.sql) to find which room1_id/room2_id this
// physical unit is allowed to write to — the device can no longer just say
// "I am room 1" the way the old firmware did, which is what let two
// different landlords' ESP32 units collide on the same room ids.

const pool = require('../lib/db');

// Roughly how often the ESP32 actually calls this endpoint (WIFI_INTERVAL
// in the firmware). Used as a fallback when we don't have a previous
// timestamp yet. The real elapsed time is measured below so unit deduction
// stays correct even if the device's send interval drifts or a request
// is missed.
const DEFAULT_INTERVAL_SECONDS = 10;

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  const deviceId = req.headers['x-device-id'];
  const deviceKey = req.headers['x-device-key'];

  if (!deviceId || !deviceKey) {
    return res.status(401).json({ error: 'Missing X-Device-Id / X-Device-Key headers.' });
  }

  try {
    const deviceRes = await pool.query(
      `SELECT device_id, room1_id, room2_id, is_active
       FROM devices WHERE device_id = $1 AND device_key = $2`,
      [deviceId, deviceKey]
    );
    const device = deviceRes.rows[0];

    if (!device || !device.is_active) {
      return res.status(403).json({ error: 'Unknown or inactive device.' });
    }

    const allowedRoomIds = new Set([device.room1_id, device.room2_id].filter((id) => id != null));

    const data = req.body;
    const readings = data && data.room_id !== undefined ? [data] : Array.isArray(data) ? data : [];
    const processedRoomIds = [];

    for (const reading of readings) {
      const room_id = parseInt(reading.room_id, 10);

      // Enforce the hierarchy: this device may ONLY write to the rooms it is
      // registered for. Anything else is dropped, not silently written to
      // whatever room_id the payload happened to contain.
      if (!allowedRoomIds.has(room_id)) {
        continue;
      }

      const voltage = parseFloat(reading.voltage) || 0;
      const current = parseFloat(reading.current) || 0;
      const power = parseFloat(reading.power) || 0;
      const energy = parseFloat(reading.energy) || 0;
      const frequency = reading.frequency !== undefined ? parseFloat(reading.frequency) : 50.0;
      const power_factor = reading.pf !== undefined ? parseFloat(reading.pf) : 1.0;

      processedRoomIds.push(room_id);

      // 1. Upsert the latest telemetry — one row per room_id, timestamped now().
      //    logged_at is always set explicitly here (not left to a DEFAULT),
      //    so it updates on every write, insert or update alike.
      const prevRes = await pool.query(
        'SELECT logged_at FROM energy_logs WHERE room_id = $1',
        [room_id]
      );
      const prevLoggedAt = prevRes.rows[0] ? prevRes.rows[0].logged_at : null;

      await pool.query(
        `INSERT INTO energy_logs (room_id, voltage, current, power, energy, frequency, power_factor, logged_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (room_id) DO UPDATE SET
           voltage = EXCLUDED.voltage,
           current = EXCLUDED.current,
           power = EXCLUDED.power,
           energy = EXCLUDED.energy,
           frequency = EXCLUDED.frequency,
           power_factor = EXCLUDED.power_factor,
           logged_at = now()`,
        [room_id, voltage, current, power, energy, frequency, power_factor]
      );

      // 2. Auto-deduct tokens based on the ACTUAL elapsed time since the last
      //    reading for this room, not a hardcoded constant. The old code
      //    assumed a fixed 3-second gap (copied from the local PZEM polling
      //    rate) even though telemetry is only sent every ~10s, which
      //    under-billed consumption by roughly 3x and made cutoffs land at
      //    the wrong balance.
      if (power > 0) {
        let elapsedSeconds = DEFAULT_INTERVAL_SECONDS;
        if (prevLoggedAt) {
          elapsedSeconds = (Date.now() - new Date(prevLoggedAt).getTime()) / 1000;
          // Guard against a stale/huge gap (device offline for a while) so a
          // single reconnect doesn't wipe out someone's whole balance.
          elapsedSeconds = Math.min(Math.max(elapsedSeconds, 0), 60);
        }
        const kwhConsumed = (power * elapsedSeconds) / 3600 / 1000;

        await pool.query(
          'UPDATE rooms SET remaining_units = GREATEST(0, remaining_units - $1) WHERE room_id = $2',
          [kwhConsumed, room_id]
        );

        // Auto-cutoff: trip relay off the instant balance hits 0.
        await pool.query(
          'UPDATE rooms SET relay_status = 0 WHERE room_id = $1 AND remaining_units <= 0',
          [room_id]
        );
      }
    }

    await pool.query('UPDATE devices SET last_seen_at = now() WHERE device_id = $1', [deviceId]);

    // 3. Retrieve relay statuses to send back to the device — scoped to this
    //    device's own rooms only.
    const targetRoomIds = processedRoomIds.length > 0 ? processedRoomIds : Array.from(allowedRoomIds);

    let roomsRows = [];
    if (targetRoomIds.length > 0) {
      const placeholders = targetRoomIds.map((_, i) => `$${i + 1}`).join(',');
      const result = await pool.query(
        `SELECT room_id, relay_status FROM rooms WHERE room_id IN (${placeholders})`,
        targetRoomIds
      );
      roomsRows = result.rows;
    }

    const relays = roomsRows.map((row) => ({
      room_id: parseInt(row.room_id, 10),
      relay_status: parseInt(row.relay_status, 10),
    }));

    return res.status(200).json({ relays });
  } catch (err) {
    return res.status(500).json({ error: 'Database Connection Failed: ' + err.message });
  }
};
