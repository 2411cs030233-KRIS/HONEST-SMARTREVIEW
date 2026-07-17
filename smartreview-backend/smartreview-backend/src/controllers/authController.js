// ============================================================
//  src/controllers/authController.js
// ============================================================
const bcrypt  = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { pool }     = require('../config/db');
const { redisClient } = require('../config/redis');
const { signToken }   = require('../middleware/auth');
const { sendEmail }   = require('../services/emailService');
const logger          = require('../utils/logger');

// ── POST /auth/register ───────────────────────────────────────
exports.register = async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {
      name, owner_name, email, phone,
      password, city, cuisine_type, table_count = 10
    } = req.body;

    // Check duplicate
    const { rows: [existing] } = await client.query(
      'SELECT id FROM restaurants WHERE email = $1', [email]
    );
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 12);
    const slug = `${name.toLowerCase().replace(/\s+/g, '-')}-${uuid().slice(0,6)}`;

    // Create restaurant
    const { rows: [restaurant] } = await client.query(`
      INSERT INTO restaurants (name, slug, owner_name, email, phone, password_hash, city, cuisine_type, plan)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'basic')
      RETURNING id, name, email, plan, slug
    `, [name, slug, owner_name, email, phone, hash, city, cuisine_type]);

    // Create default branch
    const { rows: [branch] } = await client.query(`
      INSERT INTO branches (restaurant_id, name, city, table_count)
      VALUES ($1,$2,$3,$4)
      RETURNING id
    `, [restaurant.id, `${name} - Main`, city, table_count]);

    // Create default tables
    for (let i = 1; i <= table_count; i++) {
      await client.query(
        'INSERT INTO restaurant_tables (branch_id, table_number) VALUES ($1,$2)',
        [branch.id, i]
      );
    }

    // Default menu categories
    const categories = ['Biryani','Pizza','Burger','Drinks','Starters','Desserts'];
    for (const cat of categories) {
      await client.query(
        'INSERT INTO menu_categories (restaurant_id, name) VALUES ($1,$2)',
        [restaurant.id, cat]
      );
    }

    await client.query('COMMIT');

    const token = signToken({ restaurant_id: restaurant.id, email });

    // Welcome email (async)
    sendEmail({ to: email, subject: 'Welcome to SmartReview!',
      html: `Hi ${owner_name}! Your SmartReview account for ${name} is ready.`,
      text: `Hi ${owner_name}! Your SmartReview account for ${name} is ready. Start at ${process.env.FRONTEND_URL}`,
    }).catch(e => logger.warn('Welcome email failed:', e.message));

    logger.info(`New restaurant registered: ${name} (${email})`);
    res.status(201).json({ token, restaurant });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ── POST /auth/login ──────────────────────────────────────────
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const { rows: [restaurant] } = await pool.query(
      'SELECT id, name, email, password_hash, plan, is_active FROM restaurants WHERE email = $1',
      [email]
    );

    if (!restaurant || !await bcrypt.compare(password, restaurant.password_hash))
      return res.status(401).json({ error: 'Invalid email or password' });

    if (!restaurant.is_active)
      return res.status(403).json({ error: 'Account deactivated. Contact support.' });

    const { password_hash, ...safe } = restaurant;
    const token = signToken({ restaurant_id: safe.id, email: safe.email });

    logger.info(`Login: ${email}`);
    res.json({ token, restaurant: safe });
  } catch (err) { next(err); }
};

// ── POST /auth/forgot-password ────────────────────────────────
exports.forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    const { rows: [restaurant] } = await pool.query(
      'SELECT id, name FROM restaurants WHERE email = $1', [email]
    );
    // Always 200 to prevent email enumeration
    if (!restaurant) return res.json({ message: 'If registered, a reset link has been sent.' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Store OTP — use Redis if available, fall back to DB column for dev environments
    if (redisClient) {
      await redisClient.setEx(`pwd_reset:${email}`, 900, otp);
    } else {
      // Fallback: store otp+expiry in restaurants table (add columns if needed)
      await pool.query(
        `UPDATE restaurants SET reset_otp=$1, reset_otp_expires=NOW()+INTERVAL '15 minutes' WHERE email=$2`,
        [otp, email]
      ).catch(() => {}); // ignore if columns don't exist yet
    }

    await sendEmail({ to: email, subject: 'SmartReview — Password reset OTP',
      html: `Your password reset OTP is: <strong>${otp}</strong><br>Valid for 15 minutes.` });

    logger.info(`Password reset OTP sent to ${email}`);
    res.json({ message: 'Reset OTP sent to your email.' });
  } catch (err) { next(err); }
};

// ── POST /auth/reset-password ─────────────────────────────────
exports.resetPassword = async (req, res, next) => {
  try {
    const { email, otp, new_password } = req.body;
    if (!email || !otp || !new_password)
      return res.status(400).json({ error: 'email, otp, and new_password are required' });

    let stored = null;
    if (redisClient) {
      stored = await redisClient.get(`pwd_reset:${email}`);
    } else {
      // Fallback: check DB column
      const { rows:[r] } = await pool.query(
        `SELECT reset_otp FROM restaurants WHERE email=$1 AND reset_otp_expires > NOW()`, [email]
      ).catch(() => ({ rows:[] }));
      stored = r?.reset_otp || null;
    }

    if (!stored || stored !== otp)
      return res.status(400).json({ error: 'Invalid or expired OTP' });

    const hash = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE restaurants SET password_hash=$1 WHERE email=$2', [hash, email]);

    // Clear OTP
    if (redisClient) await redisClient.del(`pwd_reset:${email}`).catch(()=>{});
    else await pool.query(`UPDATE restaurants SET reset_otp=NULL, reset_otp_expires=NULL WHERE email=$1`, [email]).catch(()=>{});

    res.json({ message: 'Password reset successfully' });
  } catch (err) { next(err); }
};

// ── GET /auth/me ──────────────────────────────────────────────
exports.getMe = async (req, res, next) => {
  try {
    const { rows: [restaurant] } = await pool.query(`
      SELECT r.id, r.name, r.slug, r.email, r.phone, r.owner_name,
             r.plan, r.plan_expires_at, r.city, r.logo_url,
             r.google_place_id, r.google_review_url,
             COUNT(DISTINCT b.id) AS total_branches
      FROM restaurants r
      LEFT JOIN branches b ON b.restaurant_id = r.id
      WHERE r.id = $1
      GROUP BY r.id
    `, [req.user.restaurant_id]);

    res.json({ data: restaurant });
  } catch (err) { next(err); }
};

// ── PATCH /auth/me ────────────────────────────────────────────
exports.updateMe = async (req, res, next) => {
  try {
    const {
      name, owner_name, phone, whatsapp_no, gstin,
      address, city, cuisine_type, google_place_id, google_review_url
    } = req.body;

    const { rows: [restaurant] } = await pool.query(`
      UPDATE restaurants
      SET name=$1, owner_name=$2, phone=$3, whatsapp_no=$4,
          gstin=$5, address=$6, city=$7, cuisine_type=$8,
          google_place_id=$9, google_review_url=$10, updated_at=NOW()
      WHERE id=$11
      RETURNING id, name, email, plan, phone, city
    `, [name, owner_name, phone, whatsapp_no, gstin, address, city, cuisine_type,
        google_place_id, google_review_url, req.user.restaurant_id]);

    res.json({ data: restaurant });
  } catch (err) { next(err); }
};

// ── POST /auth/change-password ────────────────────────────────
exports.changePassword = async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password)
      return res.status(400).json({ error: 'current_password and new_password are required' });
    if (new_password.length < 8)
      return res.status(400).json({ error: 'New password must be at least 8 characters' });

    const { rows: [restaurant] } = await pool.query(
      'SELECT password_hash FROM restaurants WHERE id = $1',
      [req.user.restaurant_id]
    );
    const valid = await bcrypt.compare(current_password, restaurant.password_hash);
    if (!valid)
      return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(new_password, 12);
    await pool.query(
      'UPDATE restaurants SET password_hash=$1, updated_at=NOW() WHERE id=$2',
      [hash, req.user.restaurant_id]
    );
    logger.info(`Password changed for restaurant ${req.user.restaurant_id}`);
    res.json({ message: 'Password changed successfully' });
  } catch (err) { next(err); }
};

// ── POST /auth/logout ─────────────────────────────────────────
exports.logout = async (req, res, next) => {
  try {
    // If Redis available, blacklist the token until expiry
    const token = req.headers.authorization?.split(' ')[1];
    if (token && redisClient) {
      try { await redisClient.setEx(`blacklist:${token}`, 60 * 60 * 24 * 7, '1'); } catch (_) {}
    }
    res.json({ message: 'Logged out successfully' });
  } catch (err) { next(err); }
};

// ── GET /auth/sessions ────────────────────────────────────────
exports.getSessions = async (req, res, next) => {
  try {
    // Returns current session info — extend later for multi-device tracking
    const { rows: [restaurant] } = await pool.query(
      'SELECT id, name, email, updated_at FROM restaurants WHERE id=$1',
      [req.user.restaurant_id]
    );
    res.json({
      data: [{
        id: 'current',
        device: req.headers['user-agent'] || 'Unknown device',
        ip: req.ip,
        created_at: new Date().toISOString(),
        is_current: true,
      }]
    });
  } catch (err) { next(err); }
};
