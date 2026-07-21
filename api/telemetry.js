// api/telemetry.js — called directly by the ESP32 firmware.
// Point the device at:  https://your-project.vercel.app/api/telemetry
//
// ARCHITECTURE NOTE (split write path):
// The ESP32 writes raw sensor readings (voltage/current/power/energy/etc)
// STRAIGHT to Supabase via its REST API (PostgREST) — see the firmware's
// pushToSupabase(). This endpoint is no longer the one writing energy_logs;
// it only receives a lightweight { room_id, power } payload so it can:
//   1. Deduct prepaid tokens for power actively being drawn, and
//   2. Decide relay ON/OFF (auto-cutoff at 0 balance), and
//   3. Reply with the current relay status for each room.
// Keeping energy_logs writes to a single writer (the ESP32) avoids two
// processes racing to upsert the same room_id row every few seconds.
//
// Still required in Supabase (for the ESP32's direct upserts to work):
//   ALTER TABLE energy_logs ADD CONSTRAINT unique_room UNIQUE (room_id);

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
        const power = parseFloat(reading.power) || 0;

        processedRoomIds.push(room_id);

        // Auto-deduct tokens if the room is actively drawing power.
        // (voltage/current/energy/frequency/pf are no longer needed here —
        // they're already being written directly to energy_logs by the
        // ESP32 itself. Only `power` matters for the deduction formula.)
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