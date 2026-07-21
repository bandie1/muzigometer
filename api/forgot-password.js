const bcrypt = require('bcryptjs');
const pool = require('../lib/db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { username, new_password, confirm_password } = req.body;

  if (new_password !== confirm_password) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE username = $1 LIMIT 1',
      [username]
    );
    const user = rows[0];
    if (!user) {
      return res.status(404).json({ error: 'Username not found.' });
    }

    const hashedPassword = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password = $1 WHERE username = $2', [
      hashedPassword,
      username,
    ]);

    return res.status(200).json({ message: 'Success! Password updated. You can now login.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update password. Please try again.' });
  }
};
