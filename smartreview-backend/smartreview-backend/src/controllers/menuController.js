// ============================================================
//  src/controllers/menuController.js
//  Full menu + category CRUD
// ============================================================
const { pool } = require('../config/db');
const logger   = require('../utils/logger');

// ── GET /menu  (list all items, grouped by category) ──────────
exports.getMenu = async (req, res, next) => {
  try {
    const { restaurant_id } = req.user;
    const { category_id, available_only, q } = req.query;

    const params = [restaurant_id];
    const conds  = ['mi.restaurant_id = $1'];
    if (category_id)    { params.push(category_id); conds.push(`mi.category_id = $${params.length}`); }
    if (available_only === 'true') conds.push('mi.is_available = TRUE');
    if (q) { params.push(`%${q}%`); conds.push(`mi.name ILIKE $${params.length}`); }

    const { rows } = await pool.query(`
      SELECT mi.*, mc.name AS category_name, mc.emoji AS category_emoji
      FROM menu_items mi
      LEFT JOIN menu_categories mc ON mc.id = mi.category_id
      WHERE ${conds.join(' AND ')}
      ORDER BY mc.display_order NULLS LAST, mi.display_order, mi.name
    `, params);

    res.json({ data: rows });
  } catch (err) { next(err); }
};

// ── GET /menu/categories ────────────────────────────────────────
exports.getCategories = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT mc.*, COUNT(mi.id)::int AS item_count
      FROM menu_categories mc
      LEFT JOIN menu_items mi ON mi.category_id = mc.id
      WHERE mc.restaurant_id = $1
      GROUP BY mc.id
      ORDER BY mc.display_order, mc.name
    `, [req.user.restaurant_id]);
    res.json({ data: rows });
  } catch (err) { next(err); }
};

// ── POST /menu/categories ───────────────────────────────────────
exports.createCategory = async (req, res, next) => {
  try {
    const { name, emoji, display_order = 0 } = req.body;
    if (!name) return res.status(400).json({ error: 'Category name required' });

    const { rows: [cat] } = await pool.query(`
      INSERT INTO menu_categories (restaurant_id, name, emoji, display_order)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [req.user.restaurant_id, name, emoji, display_order]);

    res.status(201).json({ data: cat });
  } catch (err) { next(err); }
};

// ── PATCH /menu/categories/:id ──────────────────────────────────
exports.updateCategory = async (req, res, next) => {
  try {
    const { name, emoji, display_order, is_active } = req.body;
    const { rows: [cat] } = await pool.query(`
      UPDATE menu_categories
      SET name = COALESCE($1, name), emoji = COALESCE($2, emoji),
          display_order = COALESCE($3, display_order), is_active = COALESCE($4, is_active)
      WHERE id = $5 AND restaurant_id = $6
      RETURNING *
    `, [name, emoji, display_order, is_active, req.params.id, req.user.restaurant_id]);

    if (!cat) return res.status(404).json({ error: 'Category not found' });
    res.json({ data: cat });
  } catch (err) { next(err); }
};

// ── DELETE /menu/categories/:id ─────────────────────────────────
exports.deleteCategory = async (req, res, next) => {
  try {
    const { rows: [inUse] } = await pool.query(
      'SELECT COUNT(*)::int AS c FROM menu_items WHERE category_id = $1', [req.params.id]
    );
    if (inUse.c > 0) {
      return res.status(400).json({ error: `Cannot delete — ${inUse.c} menu items still use this category` });
    }
    await pool.query(
      'DELETE FROM menu_categories WHERE id = $1 AND restaurant_id = $2',
      [req.params.id, req.user.restaurant_id]
    );
    res.json({ message: 'Category deleted' });
  } catch (err) { next(err); }
};

// ── POST /menu  (create item) ───────────────────────────────────
exports.createItem = async (req, res, next) => {
  try {
    const {
      name, price, category_id, emoji, description,
      is_veg = true, prep_time_min, allergens = [], calories, image_url
    } = req.body;

    if (!name || price == null) return res.status(400).json({ error: 'name and price are required' });
    if (price < 0) return res.status(400).json({ error: 'price must be non-negative' });

    const { rows: [item] } = await pool.query(`
      INSERT INTO menu_items (
        restaurant_id, category_id, name, price, emoji, description,
        is_veg, prep_time_min, allergens, calories, image_url
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [
      req.user.restaurant_id, category_id || null, name, price, emoji, description,
      is_veg, prep_time_min, allergens, calories, image_url
    ]);

    logger.info(`Menu item created: ${name} (₹${price})`);
    res.status(201).json({ data: item });
  } catch (err) { next(err); }
};

// ── PATCH /menu/:id  (update item, incl. sold-out toggle) ──────
exports.updateItem = async (req, res, next) => {
  try {
    const {
      name, price, emoji, description, is_available, is_veg,
      category_id, is_featured, prep_time_min
    } = req.body;

    const { rows: [item] } = await pool.query(`
      UPDATE menu_items SET
        name          = COALESCE($1, name),
        price         = COALESCE($2, price),
        emoji         = COALESCE($3, emoji),
        description   = COALESCE($4, description),
        is_available  = COALESCE($5, is_available),
        is_veg        = COALESCE($6, is_veg),
        category_id   = COALESCE($7, category_id),
        is_featured   = COALESCE($8, is_featured),
        prep_time_min = COALESCE($9, prep_time_min),
        updated_at    = NOW()
      WHERE id = $10 AND restaurant_id = $11
      RETURNING *
    `, [
      name, price, emoji, description, is_available, is_veg,
      category_id, is_featured, prep_time_min,
      req.params.id, req.user.restaurant_id
    ]);

    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json({ data: item });
  } catch (err) { next(err); }
};

// ── DELETE /menu/:id ─────────────────────────────────────────────
exports.deleteItem = async (req, res, next) => {
  try {
    const { rows: [item] } = await pool.query(
      'DELETE FROM menu_items WHERE id = $1 AND restaurant_id = $2 RETURNING name',
      [req.params.id, req.user.restaurant_id]
    );
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json({ message: `${item.name} deleted` });
  } catch (err) { next(err); }
};

// ── PATCH /menu/:id/toggle-availability  (quick sold-out toggle) ──
exports.toggleAvailability = async (req, res, next) => {
  try {
    const { rows: [item] } = await pool.query(`
      UPDATE menu_items SET is_available = NOT is_available, updated_at = NOW()
      WHERE id = $1 AND restaurant_id = $2
      RETURNING id, name, is_available
    `, [req.params.id, req.user.restaurant_id]);

    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json({ data: item });
  } catch (err) { next(err); }
};

// ── GET /menu/public/:slug  (PUBLIC — for online menu QR page) ────
exports.getPublicMenu = async (req, res, next) => {
  try {
    const { slug } = req.params;
    const { rows: [restaurant] } = await pool.query(
      'SELECT id, name, logo_url FROM restaurants WHERE slug = $1 AND is_active = TRUE', [slug]
    );
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    const { rows: items } = await pool.query(`
      SELECT mi.id, mi.name, mi.price, mi.emoji, mi.description, mi.is_veg, mi.image_url,
             mc.name AS category_name, mc.display_order
      FROM menu_items mi
      LEFT JOIN menu_categories mc ON mc.id = mi.category_id
      WHERE mi.restaurant_id = $1 AND mi.is_available = TRUE
      ORDER BY mc.display_order NULLS LAST, mi.display_order
    `, [restaurant.id]);

    res.json({ data: { restaurant, items } });
  } catch (err) { next(err); }
};
