const pool = require('../../lib/db');
const { requireRole } = require('../../lib/auth');

module.exports = async (req, res) => {
  const session = requireRole(req, res, 'landlord');
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
    // Ownership check — a landlord may only act on their own rooms.
    const ownRoom = await pool.query(
      'SELECT room_id FROM rooms WHERE room_id = $1 AND landlord_id = $2',
      [roomId, session.user_id]
    );
    if (ownRoom.rows.length === 0) {
      return res.status(403).json({ error: 'You do not have access to this room.' });
    }

    if (action === 'demo_reset') {
      await pool.query(
        'UPDATE rooms SET remaining_units = 0.0, total_paid = 0.0, relay_status = 0 WHERE room_id = $1',
        [roomId]
      );
    } else if (action === 'demo_restore') {
      await pool.query(
        'UPDATE rooms SET remaining_units = 10.0, relay_status = 1 WHERE room_id = $1',
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
