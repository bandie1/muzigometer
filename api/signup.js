const bcrypt = require('bcryptjs');
const pool = require('../lib/db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { username, password, confirm_password, role, num_rooms } = req.body;

  if (password !== confirm_password) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }
  if (!username || !password || !role) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT username FROM users WHERE username = $1 LIMIT 1',
      [username]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Username is already taken.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    let allocatedRoomId = null;
    let numRoomsInt = 0;

    if (role === 'landlord') {
      numRoomsInt = parseInt(num_rooms, 10);
      if (!numRoomsInt || numRoomsInt < 1) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Please specify at least 1 room to create.' });
      }
    } else {
      // Tenant: find an available room not occupied by any other tenant
      const roomResult = await client.query(`
        SELECT room_id FROM rooms
        WHERE room_id NOT IN (
          SELECT DISTINCT room_id FROM users
          WHERE room_id IS NOT NULL AND role = 'tenant'
        )
        ORDER BY room_id ASC LIMIT 1
      `);
      if (roomResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Registration Halted: No vacant rooms available. Please contact your Landlord to add more rooms.',
        });
      }
      allocatedRoomId = roomResult.rows[0].room_id;
    }

    const insertResult = await client.query(
      'INSERT INTO users (username, password, role, room_id) VALUES ($1, $2, $3, $4) RETURNING id',
      [username, hashedPassword, role, allocatedRoomId]
    );
    const newUserId = insertResult.rows[0].id;

    let message;
    if (role === 'landlord') {
      for (let i = 1; i <= numRoomsInt; i++) {
        await client.query(
          'INSERT INTO rooms (room_name, remaining_units, total_paid, relay_status, landlord_id) VALUES ($1, 0.00, 0.00, 0, $2)',
          [`Room ${i}`, newUserId]
        );
      }
      message = `Registration Successful! Landlord registered and ${numRoomsInt} rooms created specifically for your profile.`;
    } else {
      message = `Registration Successful! Allocated to Room Node ID: ${allocatedRoomId}`;
    }

    await client.query('COMMIT');
    return res.status(200).json({ message });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Registration failed. Please try again.' });
  } finally {
    client.release();
  }
};
