// ============================================================
//  src/controllers/loyaltyController.js
//  Points earning, redemption, tiers, rewards catalogue
// ============================================================
const { pool } = require('../config/db');
const logger   = require('../utils/logger');
const { sendWhatsApp } = require('../services/whatsappService');

const TIER_ORDER = ['bronze', 'silver', 'gold', 'platinum'];

// ── Internal: recompute tier based on lifetime points ────────────
async function recalcTier(client, restaurantId, customerId) {
  const { rows: tiers } = await client.query(
    'SELECT tier, min_points FROM loyalty_tiers WHERE restaurant_id = $1 ORDER BY min_points DESC',
    [restaurantId]
  );
  const { rows: [cust] } = await client.query(
    'SELECT lifetime_points, tier FROM customers WHERE id = $1', [customerId]
  );
  if (!cust) return null;

  const newTier = tiers.find(t => cust.lifetime_points >= t.min_points)?.tier || 'bronze';
  if (newTier !== cust.tier) {
    await client.query('UPDATE customers SET tier = $1 WHERE id = $2', [newTier, customerId]);
  }
  return { previousTier: cust.tier, newTier, upgraded: TIER_ORDER.indexOf(newTier) > TIER_ORDER.indexOf(cust.tier) };
}

// ── Internal: earn points for a paid bill (called from payment flow) ──
exports.earnPointsForBill = async (restaurantId, customerId, billId, billTotal) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [cust] } = await client.query(
      'SELECT tier, loyalty_points FROM customers WHERE id = $1', [customerId]
    );
    if (!cust) { await client.query('ROLLBACK'); return null; }

    const { rows: [tierConf] } = await client.query(
      'SELECT bonus_multiplier FROM loyalty_tiers WHERE restaurant_id = $1 AND tier = $2',
      [restaurantId, cust.tier]
    );
    const multiplier = tierConf?.bonus_multiplier || 1.0;

    // Base rule: 1 point per ₹10 spent, multiplied by tier bonus
    const basePoints = Math.floor(billTotal / 10);
    const earnedPoints = Math.round(basePoints * multiplier);

    const { rows: [updated] } = await client.query(`
      UPDATE customers
      SET loyalty_points = loyalty_points + $1, lifetime_points = lifetime_points + $1
      WHERE id = $2
      RETURNING loyalty_points
    `, [earnedPoints, customerId]);

    await client.query(`
      INSERT INTO loyalty_transactions (restaurant_id, customer_id, bill_id, type, points, reason, balance_after)
      VALUES ($1,$2,$3,'earn',$4,$5,$6)
    `, [restaurantId, customerId, billId, earnedPoints, `Earned from bill (${multiplier}x ${cust.tier} bonus)`, updated.loyalty_points]);

    const tierResult = await recalcTier(client, restaurantId, customerId);

    await client.query('COMMIT');
    logger.info(`Loyalty: +${earnedPoints} pts for customer ${customerId} (bill ₹${billTotal})`);

    return { earnedPoints, newBalance: updated.loyalty_points, tierResult };
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('earnPointsForBill failed:', err);
    return null;
  } finally {
    client.release();
  }
};

// ── GET /loyalty/customer/:id  (points balance + tier + history) ──
exports.getCustomerLoyalty = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { restaurant_id } = req.user;

    const { rows: [customer] } = await pool.query(`
      SELECT id, name, phone, loyalty_points, lifetime_points, tier, visit_count, total_spent
      FROM customers WHERE id = $1 AND restaurant_id = $2
    `, [id, restaurant_id]);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const { rows: tierConf } = await pool.query(
      'SELECT * FROM loyalty_tiers WHERE restaurant_id = $1 ORDER BY min_points', [restaurant_id]
    );
    const nextTier = tierConf.find(t => t.min_points > customer.lifetime_points);

    const { rows: history } = await pool.query(`
      SELECT * FROM loyalty_transactions WHERE customer_id = $1
      ORDER BY created_at DESC LIMIT 20
    `, [id]);

    res.json({
      data: {
        ...customer,
        next_tier: nextTier ? { tier: nextTier.tier, points_needed: nextTier.min_points - customer.lifetime_points } : null,
        history,
      }
    });
  } catch (err) { next(err); }
};

// ── GET /loyalty/customer/by-phone/:phone  (for customer-facing QR page) ──
exports.getLoyaltyByPhone = async (req, res, next) => {
  try {
    const { phone } = req.params;
    const { restaurant_id } = req.query; // public route, restaurant passed as query param

    const { rows: [customer] } = await pool.query(`
      SELECT id, name, loyalty_points, lifetime_points, tier, visit_count
      FROM customers WHERE phone = $1 AND restaurant_id = $2
    `, [phone, restaurant_id]);

    if (!customer) return res.json({ data: { loyalty_points: 0, tier: 'bronze', is_new: true } });
    res.json({ data: customer });
  } catch (err) { next(err); }
};

// ── GET /loyalty/rewards  (active rewards catalogue) ───────────────
exports.getRewards = async (req, res, next) => {
  try {
    const restaurant_id = req.user?.restaurant_id || req.query.restaurant_id;
    if (!restaurant_id) return res.status(400).json({ error: 'restaurant_id required' });
    const { rows } = await pool.query(`
      SELECT lr.*, mi.name AS item_name, mi.emoji AS item_emoji
      FROM loyalty_rewards lr
      LEFT JOIN menu_items mi ON mi.id = lr.menu_item_id
      WHERE lr.restaurant_id = $1 AND lr.is_active = TRUE
      ORDER BY lr.points_cost
    `, [restaurant_id]);
    res.json({ data: rows });
  } catch (err) { next(err); }
};

// ── POST /loyalty/rewards  (owner creates a reward) ─────────────────
exports.createReward = async (req, res, next) => {
  try {
    const { name, description, points_cost, reward_type = 'discount_pct', reward_value, menu_item_id } = req.body;
    if (!name || !points_cost) return res.status(400).json({ error: 'name and points_cost are required' });

    const { rows: [reward] } = await pool.query(`
      INSERT INTO loyalty_rewards (restaurant_id, name, description, points_cost, reward_type, reward_value, menu_item_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [req.user.restaurant_id, name, description, points_cost, reward_type, reward_value, menu_item_id]);

    res.status(201).json({ data: reward });
  } catch (err) { next(err); }
};

// ── PATCH /loyalty/rewards/:id ───────────────────────────────────────
exports.updateReward = async (req, res, next) => {
  try {
    const { name, description, points_cost, reward_value, is_active } = req.body;
    const { rows: [reward] } = await pool.query(`
      UPDATE loyalty_rewards SET
        name = COALESCE($1, name), description = COALESCE($2, description),
        points_cost = COALESCE($3, points_cost), reward_value = COALESCE($4, reward_value),
        is_active = COALESCE($5, is_active)
      WHERE id = $6 AND restaurant_id = $7 RETURNING *
    `, [name, description, points_cost, reward_value, is_active, req.params.id, req.user.restaurant_id]);

    if (!reward) return res.status(404).json({ error: 'Reward not found' });
    res.json({ data: reward });
  } catch (err) { next(err); }
};

// ── POST /loyalty/redeem  (customer redeems a reward) ────────────────
exports.redeemReward = async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { customer_id, reward_id, bill_id } = req.body;
    const { restaurant_id } = req.user;

    const { rows: [reward] } = await client.query(
      'SELECT * FROM loyalty_rewards WHERE id = $1 AND restaurant_id = $2 AND is_active = TRUE',
      [reward_id, restaurant_id]
    );
    if (!reward) throw { status: 404, message: 'Reward not found or inactive' };

    const { rows: [customer] } = await client.query(
      'SELECT loyalty_points FROM customers WHERE id = $1 AND restaurant_id = $2',
      [customer_id, restaurant_id]
    );
    if (!customer) throw { status: 404, message: 'Customer not found' };
    if (customer.loyalty_points < reward.points_cost) {
      throw { status: 400, message: `Insufficient points. Need ${reward.points_cost}, has ${customer.loyalty_points}` };
    }

    const { rows: [updated] } = await client.query(`
      UPDATE customers SET loyalty_points = loyalty_points - $1 WHERE id = $2
      RETURNING loyalty_points
    `, [reward.points_cost, customer_id]);

    await client.query(`
      INSERT INTO loyalty_transactions (restaurant_id, customer_id, bill_id, type, points, reason, balance_after)
      VALUES ($1,$2,$3,'redeem',$4,$5,$6)
    `, [restaurant_id, customer_id, bill_id || null, -reward.points_cost, `Redeemed: ${reward.name}`, updated.loyalty_points]);

    // If tied to a bill, apply the discount
    if (bill_id && reward.reward_type === 'discount_pct') {
      const { rows: [bill] } = await client.query('SELECT subtotal FROM bills WHERE id = $1', [bill_id]);
      if (bill) {
        const discAmt = +(bill.subtotal * (reward.reward_value / 100)).toFixed(2);
        await client.query(
          'UPDATE bills SET discount_pct = discount_pct + $1, discount_amt = discount_amt + $2, total = total - $2 WHERE id = $3',
          [reward.reward_value, discAmt, bill_id]
        );
      }
    } else if (bill_id && reward.reward_type === 'discount_flat') {
      await client.query(
        'UPDATE bills SET discount_amt = discount_amt + $1, total = total - $1 WHERE id = $2',
        [reward.reward_value, bill_id]
      );
    }

    await client.query('COMMIT');
    logger.info(`Reward redeemed: ${reward.name} by customer ${customer_id} (-${reward.points_cost} pts)`);

    res.json({ data: { reward, remaining_points: updated.loyalty_points } });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ── GET /loyalty/tiers  (restaurant's tier configuration) ────────────
exports.getTiers = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM loyalty_tiers WHERE restaurant_id = $1 ORDER BY min_points',
      [req.user.restaurant_id]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
};

// ── PATCH /loyalty/tiers/:tier  (customize thresholds) ────────────────
exports.updateTier = async (req, res, next) => {
  try {
    const { min_points, perk_description, bonus_multiplier } = req.body;
    const { rows: [tier] } = await pool.query(`
      UPDATE loyalty_tiers SET
        min_points = COALESCE($1, min_points),
        perk_description = COALESCE($2, perk_description),
        bonus_multiplier = COALESCE($3, bonus_multiplier)
      WHERE restaurant_id = $4 AND tier = $5 RETURNING *
    `, [min_points, perk_description, bonus_multiplier, req.user.restaurant_id, req.params.tier]);

    if (!tier) return res.status(404).json({ error: 'Tier not found' });
    res.json({ data: tier });
  } catch (err) { next(err); }
};

// ── GET /loyalty/leaderboard  (top customers by points) ───────────────
exports.getLeaderboard = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, name, phone, loyalty_points, lifetime_points, tier, visit_count
      FROM customers
      WHERE restaurant_id = $1
      ORDER BY lifetime_points DESC
      LIMIT 20
    `, [req.user.restaurant_id]);
    res.json({ data: rows });
  } catch (err) { next(err); }
};
