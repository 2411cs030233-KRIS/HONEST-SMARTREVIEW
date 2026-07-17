// ============================================================
//  src/controllers/inventoryController.js
//  Stock tracking + transactions + low-stock alerts + suppliers
// ============================================================
const { pool } = require('../config/db');
const logger   = require('../utils/logger');
const { sendWhatsApp } = require('../services/whatsappService');

// ── GET /inventory  (list items with computed stock status) ─────
exports.getInventory = async (req, res, next) => {
  try {
    const { restaurant_id } = req.user;
    const { branch_id, category, low_stock_only } = req.query;
    const params = [restaurant_id];
    const conds  = ['restaurant_id = $1', 'is_active = TRUE'];

    if (branch_id) { params.push(branch_id); conds.push(`branch_id = $${params.length}`); }
    if (category)  { params.push(category);  conds.push(`category = $${params.length}`); }
    if (low_stock_only === 'true') conds.push('current_stock <= min_stock');

    const { rows } = await pool.query(`
      SELECT *,
        CASE
          WHEN current_stock <= min_stock * 0.5 THEN 'critical'
          WHEN current_stock <= min_stock        THEN 'low'
          ELSE 'ok'
        END AS stock_status
      FROM inventory_items
      WHERE ${conds.join(' AND ')}
      ORDER BY (current_stock <= min_stock) DESC, name
    `, params);

    res.json({ data: rows });
  } catch (err) { next(err); }
};

// ── GET /inventory/alerts  (low stock items only) ────────────────
exports.getLowStockAlerts = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT *,
        ROUND((current_stock / NULLIF(min_stock, 0) * 100)::numeric, 0) AS pct_of_minimum
      FROM inventory_items
      WHERE restaurant_id = $1 AND is_active = TRUE AND current_stock <= min_stock
      ORDER BY (current_stock / NULLIF(min_stock, 0)) ASC
    `, [req.user.restaurant_id]);

    res.json({ data: rows, count: rows.length });
  } catch (err) { next(err); }
};

// ── POST /inventory  (add new item) ───────────────────────────────
exports.createItem = async (req, res, next) => {
  try {
    const {
      name, category, unit, current_stock = 0, min_stock = 0, max_stock,
      cost_per_unit, supplier_name, supplier_phone, branch_id
    } = req.body;

    if (!name || !unit) return res.status(400).json({ error: 'name and unit are required' });

    const { rows: [item] } = await pool.query(`
      INSERT INTO inventory_items (
        restaurant_id, branch_id, name, category, unit, current_stock,
        min_stock, max_stock, cost_per_unit, supplier_name, supplier_phone
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [
      req.user.restaurant_id, branch_id, name, category, unit, current_stock,
      min_stock, max_stock, cost_per_unit, supplier_name, supplier_phone
    ]);

    res.status(201).json({ data: item });
  } catch (err) { next(err); }
};

// ── PATCH /inventory/:id  (update item details) ───────────────────
exports.updateItem = async (req, res, next) => {
  try {
    const { name, category, min_stock, max_stock, cost_per_unit, supplier_name, supplier_phone } = req.body;

    const { rows: [item] } = await pool.query(`
      UPDATE inventory_items SET
        name = COALESCE($1, name), category = COALESCE($2, category),
        min_stock = COALESCE($3, min_stock), max_stock = COALESCE($4, max_stock),
        cost_per_unit = COALESCE($5, cost_per_unit),
        supplier_name = COALESCE($6, supplier_name), supplier_phone = COALESCE($7, supplier_phone),
        updated_at = NOW()
      WHERE id = $8 AND restaurant_id = $9
      RETURNING *
    `, [name, category, min_stock, max_stock, cost_per_unit, supplier_name, supplier_phone, req.params.id, req.user.restaurant_id]);

    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json({ data: item });
  } catch (err) { next(err); }
};

// ── DELETE /inventory/:id ───────────────────────────────────────
exports.deleteItem = async (req, res, next) => {
  try {
    await pool.query(
      'UPDATE inventory_items SET is_active = FALSE WHERE id = $1 AND restaurant_id = $2',
      [req.params.id, req.user.restaurant_id]
    );
    res.json({ message: 'Item archived' });
  } catch (err) { next(err); }
};

// ── POST /inventory/:id/transaction  (restock / usage / waste / adjustment) ──
exports.recordTransaction = async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const { type, quantity, notes } = req.body;

    const validTypes = ['restock', 'usage', 'waste', 'adjustment'];
    if (!validTypes.includes(type)) throw { status: 400, message: 'Invalid transaction type' };
    if (!quantity) throw { status: 400, message: 'quantity is required' };

    // restock = positive delta, everything else = negative
    const delta = type === 'restock' ? Math.abs(quantity) : -Math.abs(quantity);

    const { rows: [item] } = await client.query(`
      UPDATE inventory_items
      SET current_stock = GREATEST(0, current_stock + $1),
          last_restocked = CASE WHEN $2 = 'restock' THEN NOW() ELSE last_restocked END,
          updated_at = NOW()
      WHERE id = $3 AND restaurant_id = $4
      RETURNING *
    `, [delta, type, id, req.user.restaurant_id]);

    if (!item) throw { status: 404, message: 'Item not found' };

    await client.query(`
      INSERT INTO inventory_transactions (inventory_item_id, type, quantity, notes)
      VALUES ($1,$2,$3,$4)
    `, [id, type, delta, notes]);

    await client.query('COMMIT');
    logger.info(`Inventory transaction: ${item.name} ${type} ${delta > 0 ? '+' : ''}${delta} ${item.unit}`);

    // Auto-alert if this transaction pushed stock below minimum
    if (item.current_stock <= item.min_stock) {
      pool.query('SELECT whatsapp_no FROM restaurants WHERE id = $1', [req.user.restaurant_id])
        .then(({ rows: [r] }) => {
          if (r?.whatsapp_no) {
            sendWhatsApp(
              r.whatsapp_no,
              `📦 Low stock alert: ${item.name} is at ${item.current_stock} ${item.unit} (min: ${item.min_stock}). Restock soon!`,
              req.user.restaurant_id, null, 'alert'
            ).catch(() => {});
          }
        }).catch(() => {});
    }

    res.json({ data: item });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ── GET /inventory/transactions  (transaction history) ────────────
exports.getTransactions = async (req, res, next) => {
  try {
    const { restaurant_id } = req.user;
    const { item_id, type, limit = 50 } = req.query;
    const params = [restaurant_id];
    const conds  = ['ii.restaurant_id = $1'];

    if (item_id) { params.push(item_id); conds.push(`it.inventory_item_id = $${params.length}`); }
    if (type)    { params.push(type);    conds.push(`it.type = $${params.length}`); }

    const { rows } = await pool.query(`
      SELECT it.*, ii.name AS item_name, ii.unit, s.name AS staff_name
      FROM inventory_transactions it
      JOIN inventory_items ii ON ii.id = it.inventory_item_id
      LEFT JOIN staff s ON s.id = it.created_by
      WHERE ${conds.join(' AND ')}
      ORDER BY it.created_at DESC
      LIMIT $${params.length + 1}
    `, [...params, limit]);

    res.json({ data: rows });
  } catch (err) { next(err); }
};

// ── GET /inventory/suppliers  (distinct supplier list with stats) ─
exports.getSuppliers = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        supplier_name, supplier_phone,
        COUNT(*)::int AS item_count,
        STRING_AGG(name, ', ' ORDER BY name) AS items_supplied,
        MAX(last_restocked) AS last_order
      FROM inventory_items
      WHERE restaurant_id = $1 AND supplier_name IS NOT NULL AND is_active = TRUE
      GROUP BY supplier_name, supplier_phone
      ORDER BY supplier_name
    `, [req.user.restaurant_id]);

    res.json({ data: rows });
  } catch (err) { next(err); }
};
