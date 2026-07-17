// ============================================================
//  src/middleware/auth.js  —  JWT authentication middleware
// ============================================================
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');

const JWT_SECRET  = process.env.JWT_SECRET  || 'changeme_in_production';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';

// ── Sign a token ─────────────────────────────────────────────
exports.signToken = (payload) =>
  jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });

// ── Verify middleware ─────────────────────────────────────────
exports.protect = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer '))
      return res.status(401).json({ error: 'No token provided' });

    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    // Check restaurant still exists and is active
    const { rows: [restaurant] } = await pool.query(
      'SELECT id, name, email, plan, is_active FROM restaurants WHERE id = $1',
      [decoded.restaurant_id]
    );

    if (!restaurant || !restaurant.is_active)
      return res.status(401).json({ error: 'Account not found or deactivated' });

    req.user = { ...decoded, ...restaurant };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError')
      return res.status(401).json({ error: 'Token expired. Please sign in again.' });
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ── Plan-level gate ───────────────────────────────────────────
exports.requirePlan = (...plans) => (req, res, next) => {
  if (!plans.includes(req.user.plan))
    return res.status(403).json({
      error: `This feature requires ${plans.join(' or ')} plan`,
      current_plan: req.user.plan,
      upgrade_url: `${process.env.FRONTEND_URL}/plans`
    });
  next();
};

// ── Staff PIN auth (for waiter-level access) ──────────────────
exports.staffPin = async (req, res, next) => {
  try {
    const { pin, staff_id } = req.body;
    const { rows: [staff] } = await pool.query(
      'SELECT * FROM staff WHERE id = $1 AND is_active = TRUE',
      [staff_id]
    );
    if (!staff || staff.pin !== pin)
      return res.status(401).json({ error: 'Invalid PIN' });
    req.staff = staff;
    next();
  } catch (err) { next(err); }
};
