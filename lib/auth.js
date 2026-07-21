// lib/auth.js — replaces PHP's $_SESSION with a signed, httpOnly JWT cookie.
//
// WHY: Vercel serverless functions are stateless — each request can hit a
// different (or freshly cold-started) instance, so PHP-style server-side
// session files don't exist here. Instead, the "session" data (user_id,
// username, role, room_id) is signed into a JWT and stored in an httpOnly
// cookie on the user's browser. The server verifies the signature on every
// request instead of looking up session state.

const jwt = require('jsonwebtoken');
const cookie = require('cookie');

// Set this in Vercel's Environment Variables — a long random string.
// Generate one with: openssl rand -base64 48
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_TO_A_LONG_RANDOM_SECRET';
const COOKIE_NAME = 'mizigo_session';

function createSessionCookie(payload) {
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
  return cookie.serialize(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,       // requires HTTPS — Vercel serves everything over HTTPS by default
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 8, // 8 hours, matches JWT expiry
  });
}

function clearSessionCookie() {
  return cookie.serialize(COOKIE_NAME, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

// Reads and verifies the session cookie from an incoming request.
// Returns the decoded payload ({ user_id, username, role, room_id }) or null.
function getSession(req) {
  const cookies = cookie.parse(req.headers.cookie || '');
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null; // expired or tampered token
  }
}

// Use at the top of any protected API route:
//   const session = requireRole(req, res, 'admin');
//   if (!session) return; // response already sent
function requireRole(req, res, role) {
  const session = getSession(req);
  if (!session || (role && session.role !== role)) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }
  return session;
}

module.exports = { createSessionCookie, clearSessionCookie, getSession, requireRole };
