// api/telemetry.js — called directly by the ESP32 firmware.
// Point the device at:  https://your-project.vercel.app/api/telemetry
//
// NOTE: For the upsert below to work, energy_logs must have a UNIQUE
// constraint on room_id (one row per room):
//   ALTER TABLE energy_logs ADD CONSTRAINT unique_room UNIQUE (room_id);
// and a logged_at timestamp column so dashboards can tell fresh vs stale:
//   ALTER TABLE energy_logs ALTER COLUMN logged_at SET DEFAULT now();

const pool = require('../lib/db');

module.exports = async (req, res) => {
  // Always reply in JSON, even on failure — the ESP32's JSON parser expects it.
  res.setHeader('Content-Type', 'application/json');

  const data = req.body;
  const processedRoomIds = [];

  try {
    if (data && typeof data === 'object') {
      // If the ESP32 sends a single object rather than an array, wrap it.
      const readings = data.room_id !== undefined ? [data] : data;

      for (const reading of Array.isArray(readings) ? readings : []) {
        const room_id = parseInt(reading.room_id, 10);
        const voltage = parseFloat(reading.voltage) || 0;
        const current = parseFloat(reading.current) || 0;
        const power = parseFloat(reading.power) || 0;
        const energy = parseFloat(reading.energy) || 0;
        const frequency = reading.frequency !== undefined ? parseFloat(reading.frequency) : 50.0;
        const power_factor = reading.pf !== undefined ? parseFloat(reading.pf) : 1.0;

        processedRoomIds.push(room_id);

        // 1. Upsert the latest telemetry — one row per room_id, timestamped now().
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

        // 2. Auto-deduct tokens if the room is actively drawing power.
        if (power > 0) {
          const kwhConsumed = (power * 3) / 3600 / 1000; // assumes ~3s telemetry interval

          await pool.query(
            'UPDATE rooms SET remaining_units = GREATEST(0, remaining_units - $1) WHERE room_id = $2',
            [kwhConsumed, room_id]
          );

          // Auto-cutoff: trip relay off if balance hits 0.
          await pool.query(
            'UPDATE rooms SET relay_status = 0 WHERE room_id = $1 AND remaining_units <= 0',
            [room_id]
          );
        }
      }
    }

    // 3. Retrieve relay statuses to send back to the device.
    let targetRoomIds = [];
    if (processedRoomIds.length > 0) {
      targetRoomIds = processedRoomIds;
    } else if (req.query.room_id) {
      targetRoomIds = String(req.query.room_id).split(',').map((id) => parseInt(id, 10));
    }

    let roomsRows;
    if (targetRoomIds.length > 0) {
      const placeholders = targetRoomIds.map((_, i) => `$${i + 1}`).join(',');
      const result = await pool.query(
        `SELECT room_id, relay_status FROM rooms WHERE room_id IN (${placeholders})`,
        targetRoomIds
      );
      roomsRows = result.rows;
    } else {
      const result = await pool.query('SELECT room_id, relay_status FROM rooms');
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
