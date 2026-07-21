const bcrypt = require('bcryptjs');
const pool = require('../lib/db');
const { createSessionCookie } = require('../lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  // 1. Core Priority Check: Hardcoded Creator Admin Credentials
  //    (kept from the original PHP for parity — consider replacing with a
  //    real DB-backed admin account before going live)
  if (username === 'admin' && password === 'admin123') {
    const cookieStr = createSessionCookie({
      user_id: 0,
      username: 'System Creator',
      role: 'admin',
      room_id: 0,
    });
    res.setHeader('Set-Cookie', cookieStr);
    return res.status(200).json({ role: 'admin' });
  }

  // 2. Fallback Check: look inside the database for standard tenants/landlords
  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE username = $1 LIMIT 1',
      [username]
    );
    const user = rows[0];

    if (!user) {
      return res.status(401).json({ error: 'No matching user found on this gateway.' });
    }

    const passwordMatches = await bcrypt.compare(password, user.password);
    if (!passwordMatches) {
      return res.status(401).json({ error: 'Invalid password. Access Denied.' });
    }

    const cookieStr = createSessionCookie({
      user_id: user.id,
      username: user.username,
      role: user.role,
      room_id: user.room_id,
    });
    res.setHeader('Set-Cookie', cookieStr);
    return res.status(200).json({ role: user.role });
  } catch (err) {
    return res.status(500).json({ error: 'Database error: ' + err.message });
  }
};
