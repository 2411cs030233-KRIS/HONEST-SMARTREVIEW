// ============================================================
//  src/controllers/staffController.js
//  Staff CRUD + shift scheduling + table assignment + performance
// ============================================================
const { pool }  = require('../config/db');
const bcrypt    = require('bcryptjs');
const logger    = require('../utils/logger');

// ── GET /staff  (list, filterable) ──────────────────────────────
exports.getStaff = async (req, res, next) => {
  try {
    const { restaurant_id } = req.user;
    const { branch_id, role, is_active } = req.query;
    const params = [restaurant_id];
    const conds  = ['restaurant_id = $1'];

    if (branch_id)  { params.push(branch_id); conds.push(`branch_id = $${params.length}`); }
    if (role)       { params.push(role);      conds.push(`role = $${params.length}`); }
    if (is_active !== undefined) { params.push(is_active === 'true'); conds.push(`is_active = $${params.length}`); }

    const { rows } = await pool.query(`
      SELECT id, name, phone, role, shift, branch_id, salary, joined_at, is_active, created_at
      FROM staff
      WHERE ${conds.join(' AND ')}
      ORDER BY name
    `, params);

    res.json({ data: rows });
  } catch (err) { next(err); }
};

// ── POST /staff  (add staff member) ─────────────────────────────
exports.createStaff = async (req, res, next) => {
  try {
    const { name, phone, role = 'waiter', branch_id, shift, salary, pin, joined_at } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'name and phone are required' });

    const pinHash = pin || String(Math.floor(1000 + Math.random() * 9000));

    const { rows: [staff] } = await pool.query(`
      INSERT INTO staff (restaurant_id, branch_id, name, phone, role, shift, salary, pin, joined_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING id, name, phone, role, shift, salary, joined_at, is_active
    `, [req.user.restaurant_id, branch_id, name, phone, role, shift, salary, pinHash, joined_at || new Date()]);

    logger.info(`Staff added: ${name} (${role})`);
    res.status(201).json({ data: staff, pin: pinHash });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A staff member with this phone already exists' });
    next(err);
  }
};

// ── PATCH /staff/:id  (update / change status) ──────────────────
exports.updateStaff = async (req, res, next) => {
  try {
    const { name, phone, role, shift, salary, is_active, branch_id } = req.body;

    const { rows: [staff] } = await pool.query(`
      UPDATE staff SET
        name = COALESCE($1, name), phone = COALESCE($2, phone),
        role = COALESCE($3, role), shift = COALESCE($4, shift),
        salary = COALESCE($5, salary), is_active = COALESCE($6, is_active),
        branch_id = COALESCE($7, branch_id)
      WHERE id = $8 AND restaurant_id = $9
      RETURNING id, name, phone, role, shift, salary, is_active
    `, [name, phone, role, shift, salary, is_active, branch_id, req.params.id, req.user.restaurant_id]);

    if (!staff) return res.status(404).json({ error: 'Staff member not found' });
    res.json({ data: staff });
  } catch (err) { next(err); }
};

// ── DELETE /staff/:id ────────────────────────────────────────────
exports.deleteStaff = async (req, res, next) => {
  try {
    const { rows: [staff] } = await pool.query(
      'DELETE FROM staff WHERE id = $1 AND restaurant_id = $2 RETURNING name',
      [req.params.id, req.user.restaurant_id]
    );
    if (!staff) return res.status(404).json({ error: 'Staff member not found' });
    res.json({ message: `${staff.name} removed` });
  } catch (err) { next(err); }
};

// ── GET /staff/performance  (ranked by tables served + rating) ──
exports.getPerformance = async (req, res, next) => {
  try {
    const { restaurant_id } = req.user;
    const { days = 7 } = req.query;

    // Performance derived from table_assignments + bills served + feedback ratings
    const { rows } = await pool.query(`
      SELECT
        s.id, s.name, s.role, s.shift,
        COUNT(DISTINCT ta.id)::int AS tables_served,
        COALESCE(SUM(b.total), 0) AS revenue_handled,
        ROUND(AVG(f.rating)::numeric, 2) AS avg_rating
      FROM staff s
      LEFT JOIN table_assignments ta ON ta.staff_id = s.id
        AND ta.assigned_at >= NOW() - ($2 || ' days')::INTERVAL
      LEFT JOIN bills b ON b.table_id = ta.table_id
        AND b.created_at >= ta.assigned_at
        AND (ta.released_at IS NULL OR b.created_at <= ta.released_at)
      LEFT JOIN feedback f ON f.bill_id = b.id
      WHERE s.restaurant_id = $1 AND s.is_active = TRUE
      GROUP BY s.id, s.name, s.role, s.shift
      ORDER BY revenue_handled DESC
    `, [restaurant_id, +days]);

    res.json({ data: rows });
  } catch (err) { next(err); }
};

// ── GET /staff/table-assignments  (today's floor map) ────────────
exports.getTableAssignments = async (req, res, next) => {
  try {
    const { restaurant_id } = req.user;
    const { branch_id } = req.query;
    const params = [restaurant_id];
    let branchFilter = '';
    if (branch_id) { params.push(branch_id); branchFilter = `AND rt.branch_id = $${params.length}`; }

    const { rows } = await pool.query(`
      SELECT rt.id AS table_id, rt.table_number, rt.status,
             ta.staff_id, s.name AS staff_name, s.role AS staff_role
      FROM restaurant_tables rt
      JOIN branches br ON br.id = rt.branch_id
      LEFT JOIN LATERAL (
        SELECT * FROM table_assignments
        WHERE table_id = rt.id AND released_at IS NULL
        ORDER BY assigned_at DESC LIMIT 1
      ) ta ON true
      LEFT JOIN staff s ON s.id = ta.staff_id
      WHERE br.restaurant_id = $1 ${branchFilter}
      ORDER BY rt.table_number
    `, params);

    res.json({ data: rows });
  } catch (err) { next(err); }
};

// ── POST /staff/assign-table  (assign / reassign waiter) ────────
exports.assignTable = async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { table_id, staff_id } = req.body;
    if (!table_id) return res.status(400).json({ error: 'table_id is required' });

    // Release any existing active assignment for this table
    await client.query(
      `UPDATE table_assignments SET released_at = NOW() WHERE table_id = $1 AND released_at IS NULL`,
      [table_id]
    );

    let result = null;
    if (staff_id) {
      const { rows: [assignment] } = await client.query(`
        INSERT INTO table_assignments (staff_id, table_id) VALUES ($1,$2) RETURNING *
      `, [staff_id, table_id]);
      result = assignment;
    }

    await client.query('COMMIT');
    res.json({ data: result, message: staff_id ? 'Table assigned' : 'Table unassigned' });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ── GET /staff/shifts  (weekly schedule) ─────────────────────────
// Shifts are stored as a JSONB blob per staff for simplicity (day-of-week -> shift name)
exports.getShifts = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, name, role, shift AS default_shift
      FROM staff
      WHERE restaurant_id = $1 AND is_active = TRUE
      ORDER BY name
    `, [req.user.restaurant_id]);
    res.json({ data: rows });
  } catch (err) { next(err); }
};

// ── PATCH /staff/:id/shift  (update default shift) ───────────────
exports.updateShift = async (req, res, next) => {
  try {
    const { shift } = req.body;
    const valid = ['morning', 'afternoon', 'evening', 'night'];
    if (!valid.includes(shift)) return res.status(400).json({ error: 'Invalid shift value' });

    const { rows: [staff] } = await pool.query(
      'UPDATE staff SET shift = $1 WHERE id = $2 AND restaurant_id = $3 RETURNING id, name, shift',
      [shift, req.params.id, req.user.restaurant_id]
    );
    if (!staff) return res.status(404).json({ error: 'Staff member not found' });
    res.json({ data: staff });
  } catch (err) { next(err); }
};

// ── POST /staff/login  (PIN-based login for waiters/cashiers) ───
exports.staffLogin = async (req, res, next) => {
  try {
    const { phone, pin } = req.body;
    const { rows: [staff] } = await pool.query(
      'SELECT id, name, role, pin, restaurant_id, branch_id FROM staff WHERE phone = $1 AND is_active = TRUE',
      [phone]
    );
    if (!staff || staff.pin !== pin) return res.status(401).json({ error: 'Invalid phone or PIN' });

    const { pin: _pin, ...safe } = staff;
    res.json({ data: safe });
  } catch (err) { next(err); }
};
