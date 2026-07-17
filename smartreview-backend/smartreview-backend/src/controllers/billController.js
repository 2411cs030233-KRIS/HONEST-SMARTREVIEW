// ============================================================
//  SmartReview — src/controllers/billController.js
// ============================================================
const { pool }   = require('../config/db');
const QRCode     = require('qrcode');
const { v4: uuid } = require('uuid');
const dayjs      = require('dayjs');
const logger     = require('../utils/logger');
const { sendWhatsApp } = require('../services/whatsappService');

// ── GET /bills  (paginated, filterable) ──────────────────────
exports.getBills = async (req, res, next) => {
  try {
    const { restaurant_id } = req.user;
    const {
      branch_id, status, date_from, date_to,
      page = 1, limit = 20, q
    } = req.query;

    const offset = (page - 1) * limit;
    const params = [restaurant_id];
    const conditions = ['b.restaurant_id = $1'];

    if (branch_id) { params.push(branch_id); conditions.push(`b.branch_id = $${params.length}`); }
    if (status)    { params.push(status);    conditions.push(`b.status = $${params.length}`); }
    if (date_from) { params.push(date_from); conditions.push(`b.created_at >= $${params.length}`); }
    if (date_to)   { params.push(date_to);   conditions.push(`b.created_at <= $${params.length}`); }
    if (q)         { params.push(`%${q}%`);  conditions.push(`(b.bill_number ILIKE $${params.length} OR c.phone ILIKE $${params.length})`); }

    const where = conditions.join(' AND ');

    const { rows } = await pool.query(`
      SELECT
        b.id, b.bill_number, b.total, b.status,
        b.discount_pct, b.gst_amt, b.created_at, b.paid_at,
        b.customer_phone, b.whatsapp_sent, b.qr_url,
        rt.table_number,
        f.rating, f.google_review_done, f.discount_pct AS feedback_disc,
        p.method AS payment_method, p.razorpay_payment_id,
        c.name AS customer_name
      FROM bills b
      LEFT JOIN restaurant_tables rt ON rt.id = b.table_id
      LEFT JOIN feedback f           ON f.bill_id = b.id
      LEFT JOIN payments p           ON p.bill_id = b.id AND p.status = 'captured'
      LEFT JOIN customers c          ON c.id = b.customer_id
      WHERE ${where}
      ORDER BY b.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*) FROM bills b LEFT JOIN customers c ON c.id = b.customer_id WHERE ${where}`,
      params
    );

    res.json({
      data: rows,
      pagination: { page: +page, limit: +limit, total: +count, pages: Math.ceil(count / limit) }
    });
  } catch (err) { next(err); }
};

// ── POST /bills  (create bill + QR) ─────────────────────────
exports.createBill = async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { restaurant_id } = req.user;
    const {
      branch_id, table_id, customer_phone,
      items = [], discount_pct = 0, gst_pct = 5, notes
    } = req.body;

    // Validate menu items & calculate totals
    if (!items.length) throw { status: 400, message: 'At least one item required' };

    let subtotal = 0;
    const enrichedItems = [];
    for (const item of items) {
      const { rows: [mi] } = await client.query(
        'SELECT id, name, price, emoji FROM menu_items WHERE id = $1 AND restaurant_id = $2 AND is_available = TRUE',
        [item.menu_item_id, restaurant_id]
      );
      if (!mi) throw { status: 422, message: `Item ${item.menu_item_id} not found or unavailable` };
      const lineTotal = mi.price * item.quantity;
      subtotal += lineTotal;
      enrichedItems.push({ menu_item_id: mi.id, name: mi.name, price: mi.price, quantity: item.quantity, subtotal: lineTotal, emoji: mi.emoji });
    }

    const discountAmt = +(subtotal * (discount_pct / 100)).toFixed(2);
    const afterDisc   = subtotal - discountAmt;
    const gstAmt      = +(afterDisc * (gst_pct / 100)).toFixed(2);
    const total       = +(afterDisc + gstAmt).toFixed(2);

    // Generate bill number
    const billNumber = `B${Date.now().toString().slice(-6)}`;
    const billId = uuid();

    // Upsert customer
    let customerId = null;
    if (customer_phone) {
      const { rows: [cust] } = await client.query(`
        INSERT INTO customers (restaurant_id, phone) VALUES ($1, $2)
        ON CONFLICT (restaurant_id, phone) DO UPDATE SET updated_at = NOW()
        RETURNING id
      `, [restaurant_id, customer_phone]);
      customerId = cust.id;
    }

    // Insert bill
    const { rows: [bill] } = await client.query(`
      INSERT INTO bills (
        id, bill_number, restaurant_id, branch_id, table_id,
        customer_id, customer_phone, items, subtotal,
        discount_pct, discount_amt, gst_pct, gst_amt, total, notes
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15
      ) RETURNING *
    `, [
      billId, billNumber, restaurant_id, branch_id, table_id,
      customerId, customer_phone,
      JSON.stringify(enrichedItems), subtotal,
      discount_pct, discountAmt, gst_pct, gstAmt, total, notes
    ]);

    // Insert line items
    for (const it of enrichedItems) {
      await client.query(`
        INSERT INTO bill_items (bill_id, menu_item_id, name, price, quantity, subtotal)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [billId, it.menu_item_id, it.name, it.price, it.quantity, it.subtotal]);

      // Update denormalized counters
      await client.query(`
        UPDATE menu_items SET total_orders = total_orders + $1, total_revenue = total_revenue + $2
        WHERE id = $3
      `, [it.quantity, it.subtotal, it.menu_item_id]);
    }

    // Mark table as billing
    if (table_id) {
      await client.query(
        `UPDATE restaurant_tables SET status='billing', current_bill_id=$1, occupied_since=NOW() WHERE id=$2`,
        [billId, table_id]
      );
    }

    // Generate QR code
    const feedbackUrl = `${process.env.FRONTEND_URL}/pay/${billId}`;
    const qrDataUrl   = await QRCode.toDataURL(feedbackUrl);
    await client.query(
      'UPDATE bills SET qr_url=$1, feedback_url=$2 WHERE id=$3',
      [qrDataUrl, feedbackUrl, billId]
    );

    await client.query('COMMIT');
    logger.info(`Bill created: ${billNumber} | ₹${total}`);

    // Async: send WhatsApp (fire & forget)
    if (customer_phone) {
      sendWhatsApp(customer_phone, `Hi! Your bill at Spice Garden is ready.\nAmount: ₹${total}\nScan to pay & rate: ${feedbackUrl}`)
        .catch(err => logger.warn('WhatsApp send failed:', err.message));
    }

    res.status(201).json({ data: { ...bill, qr_url: qrDataUrl, feedback_url: feedbackUrl } });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ── GET /bills/:id ────────────────────────────────────────────
exports.getBillById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { restaurant_id } = req.user;
    const { rows: [bill] } = await pool.query(`
      SELECT b.*, rt.table_number, c.name AS customer_name,
             f.rating, f.complaints, f.comment, f.google_review_done,
             p.method, p.razorpay_payment_id, p.status AS payment_status,
             json_agg(bi.*) AS line_items
      FROM bills b
      LEFT JOIN restaurant_tables rt ON rt.id = b.table_id
      LEFT JOIN customers c          ON c.id  = b.customer_id
      LEFT JOIN feedback f           ON f.bill_id = b.id
      LEFT JOIN payments p           ON p.bill_id = b.id
      LEFT JOIN bill_items bi        ON bi.bill_id = b.id
      WHERE b.id = $1 AND b.restaurant_id = $2
      GROUP BY b.id, rt.table_number, c.name, f.rating, f.complaints, f.comment, f.google_review_done, p.method, p.razorpay_payment_id, p.status
    `, [id, restaurant_id]);

    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    res.json({ data: bill });
  } catch (err) { next(err); }
};

// ── PATCH /bills/:id/status ───────────────────────────────────
exports.updateBillStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const { restaurant_id } = req.user;

    const { rows: [bill] } = await pool.query(`
      UPDATE bills SET status=$1, paid_at=CASE WHEN $1='paid' THEN NOW() ELSE paid_at END
      WHERE id=$2 AND restaurant_id=$3
      RETURNING *
    `, [status, id, restaurant_id]);

    if (!bill) return res.status(404).json({ error: 'Bill not found' });

    if (status === 'paid' && bill.table_id) {
      await pool.query(
        `UPDATE restaurant_tables SET status='dirty', current_bill_id=NULL WHERE id=$1`,
        [bill.table_id]
      );
    }

    res.json({ data: bill });
  } catch (err) { next(err); }
};
