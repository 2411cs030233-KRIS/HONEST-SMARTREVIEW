// ============================================================
//  src/controllers/paymentController.js  —  Razorpay integration
// ============================================================
const Razorpay  = require('razorpay');
const crypto    = require('crypto');
const { pool }  = require('../config/db');
const { v4: uuid } = require('uuid');
const logger    = require('../utils/logger');
const { sendWhatsApp, sendPaymentReceipt } = require('../services/whatsappService');

// Lazy-load Razorpay per restaurant (each has own keys)
function getRazorpay(keyId, keySecret) {
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

// ── POST /payments/create-order ───────────────────────────────
exports.createOrder = async (req, res, next) => {
  try {
    const { bill_id } = req.body;
    const { restaurant_id } = req.user;

    const { rows: [bill] } = await pool.query(
      'SELECT * FROM bills WHERE id=$1 AND restaurant_id=$2', [bill_id, restaurant_id]
    );
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    if (bill.status === 'paid') return res.status(400).json({ error: 'Bill already paid' });

    const { rows: [restaurant] } = await pool.query(
      'SELECT razorpay_key_id, razorpay_key_secret FROM restaurants WHERE id=$1',
      [restaurant_id]
    );
    if (!restaurant.razorpay_key_id)
      return res.status(400).json({ error: 'Razorpay not configured. Add keys in settings.' });

    const rzp = getRazorpay(restaurant.razorpay_key_id, restaurant.razorpay_key_secret);

    const order = await rzp.orders.create({
      amount: Math.round(bill.total * 100),   // paise
      currency: 'INR',
      receipt: bill.bill_number,
      notes: { bill_id, restaurant_id },
    });

    // Store initial payment record
    await pool.query(`
      INSERT INTO payments (bill_id, restaurant_id, razorpay_order_id, amount, status)
      VALUES ($1,$2,$3,$4,'created')
    `, [bill_id, restaurant_id, order.id, bill.total]);

    res.json({
      data: {
        order_id: order.id,
        amount: order.amount,
        currency: order.currency,
        key_id: restaurant.razorpay_key_id,
        bill_number: bill.bill_number,
        restaurant_name: req.user.name,
      }
    });
  } catch (err) { next(err); }
};

// ── POST /payments/verify ─────────────────────────────────────
exports.verifyPayment = async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {
      razorpay_order_id, razorpay_payment_id,
      razorpay_signature, bill_id, method
    } = req.body;
    const { restaurant_id } = req.user;

    // Fetch key secret
    const { rows: [restaurant] } = await client.query(
      'SELECT razorpay_key_secret, name FROM restaurants WHERE id=$1', [restaurant_id]
    );

    // Verify signature
    const body   = razorpay_order_id + '|' + razorpay_payment_id;
    const digest = crypto
      .createHmac('sha256', restaurant.razorpay_key_secret)
      .update(body).digest('hex');

    if (digest !== razorpay_signature) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Payment verification failed. Possible tampering.' });
    }

    // Update payment record
    await client.query(`
      UPDATE payments
      SET razorpay_payment_id=$1, razorpay_signature=$2,
          status='captured', method=$3, captured_at=NOW()
      WHERE razorpay_order_id=$4
    `, [razorpay_payment_id, razorpay_signature, method, razorpay_order_id]);

    // Mark bill as paid
    const { rows: [bill] } = await client.query(`
      UPDATE bills SET status='paid', paid_at=NOW()
      WHERE id=$1 AND restaurant_id=$2
      RETURNING *, (SELECT table_number FROM restaurant_tables WHERE id=bills.table_id) AS table_number
    `, [bill_id, restaurant_id]);

    // Free the table
    if (bill.table_id) {
      await client.query(
        `UPDATE restaurant_tables SET status='dirty', current_bill_id=NULL WHERE id=$1`,
        [bill.table_id]
      );
    }

    // Update customer stats
    if (bill.customer_id) {
      await client.query(`
        UPDATE customers
        SET visit_count=visit_count+1, total_spent=total_spent+$1, last_visit_at=NOW()
        WHERE id=$2
      `, [bill.total, bill.customer_id]);
    }

    await client.query('COMMIT');
    logger.info(`Payment captured: ${razorpay_payment_id} | ₹${bill.total}`);

    // WhatsApp receipt (async)
    if (bill.customer_phone) {
      const msg = `✅ Payment successful!\n\nBill: ${bill.bill_number}\nAmount: ₹${bill.total}\nMethod: ${method}\nRef: ${razorpay_payment_id}\n\nThank you for dining at ${restaurant.name}! 🙏`;
      sendWhatsApp(bill.customer_phone, msg)
        .catch(e => logger.warn('Receipt WA failed:', e.message));
    }

    res.json({
      data: {
        success: true,
        payment_id: razorpay_payment_id,
        bill_number: bill.bill_number,
        amount: bill.total,
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ── POST /payments/cash ───────────────────────────────────────
exports.recordCash = async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { bill_id, amount_received } = req.body;
    const { restaurant_id } = req.user;

    const { rows: [bill] } = await client.query(
      'SELECT * FROM bills WHERE id=$1 AND restaurant_id=$2', [bill_id, restaurant_id]
    );
    if (!bill) return res.status(404).json({ error: 'Bill not found' });

    await client.query(`
      INSERT INTO payments (bill_id, restaurant_id, amount, method, status, captured_at)
      VALUES ($1,$2,$3,'cash','captured',NOW())
    `, [bill_id, restaurant_id, bill.total]);

    await client.query(
      `UPDATE bills SET status='paid', paid_at=NOW() WHERE id=$1`,
      [bill_id]
    );

    if (bill.table_id) {
      await client.query(
        `UPDATE restaurant_tables SET status='dirty', current_bill_id=NULL WHERE id=$1`,
        [bill.table_id]
      );
    }

    await client.query('COMMIT');
    res.json({ data: { success: true, change: amount_received - bill.total } });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ── GET /payments  (transaction history) ─────────────────────
exports.getTransactions = async (req, res, next) => {
  try {
    const { restaurant_id } = req.user;
    const { from, to, method, status, page=1, limit=20 } = req.query;
    const offset = (page-1)*limit;
    const params = [restaurant_id];
    const conds  = ['b.restaurant_id=$1'];
    if (from)   { params.push(from);   conds.push(`p.created_at>=$${params.length}`); }
    if (to)     { params.push(to);     conds.push(`p.created_at<=$${params.length}`); }
    if (method) { params.push(method); conds.push(`p.method=$${params.length}`); }
    if (status) { params.push(status); conds.push(`p.status=$${params.length}`); }

    const { rows } = await pool.query(`
      SELECT p.*, b.bill_number, b.total AS bill_total,
             rt.table_number, c.phone AS customer_phone
      FROM payments p
      JOIN bills b ON b.id=p.bill_id
      LEFT JOIN restaurant_tables rt ON rt.id=b.table_id
      LEFT JOIN customers c ON c.id=b.customer_id
      WHERE ${conds.join(' AND ')}
      ORDER BY p.created_at DESC
      LIMIT $${params.length+1} OFFSET $${params.length+2}
    `, [...params, limit, offset]);

    const { rows:[{count}] } = await pool.query(
      `SELECT COUNT(*) FROM payments p JOIN bills b ON b.id=p.bill_id WHERE ${conds.join(' AND ')}`,
      params
    );

    res.json({ data:rows, pagination:{page:+page,limit:+limit,total:+count} });
  } catch(err){ next(err); }
};

// ── POST /webhooks/razorpay  (Razorpay webhook) ───────────────
exports.razorpayWebhook = async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const sig    = req.headers['x-razorpay-signature'];
    const digest = crypto.createHmac('sha256', secret)
      .update(JSON.stringify(req.body)).digest('hex');
    if (digest !== sig) return res.status(400).send('Invalid signature');

    const { event, payload } = req.body;
    if (event === 'payment.captured') {
      const pid = payload.payment.entity.id;
      await pool.query(
        `UPDATE payments SET status='captured', captured_at=NOW() WHERE razorpay_payment_id=$1`,
        [pid]
      );
      logger.info(`Webhook: payment.captured ${pid}`);
    }
    if (event === 'payment.failed') {
      const pid = payload.payment.entity.id;
      const reason = payload.payment.entity.error_description;
      await pool.query(
        `UPDATE payments SET status='failed', failure_reason=$1 WHERE razorpay_payment_id=$2`,
        [reason, pid]
      );
    }

    res.json({ received: true });
  } catch (err) {
    logger.error('Webhook error:', err);
    res.status(500).send('Webhook error');
  }
};

// ============================================================
//  PUBLIC PAYMENT ENDPOINTS — No auth token needed
//  Called from customer QR page (customer-bill.html)
//  Uses bill_id to derive restaurant_id — no JWT required
// ============================================================

// ── POST /payments/public/create-order ───────────────────────
// Customer initiates Razorpay payment from their phone
exports.publicCreateOrder = async (req, res, next) => {
  try {
    const { bill_id, amount_paise } = req.body;
    if (!bill_id) return res.status(400).json({ error: 'bill_id is required' });

    // Get bill + restaurant keys in one query
    const { rows: [bill] } = await pool.query(`
      SELECT b.*, r.razorpay_key_id, r.razorpay_key_secret,
             r.name AS restaurant_name, r.gstin,
             r.whatsapp_no AS owner_whatsapp
      FROM bills b
      JOIN restaurants r ON r.id = b.restaurant_id
      WHERE b.id = $1
    `, [bill_id]);

    if (!bill)           return res.status(404).json({ error: 'Bill not found' });
    if (bill.status === 'paid') return res.status(400).json({ error: 'Bill already paid' });
    if (!bill.razorpay_key_id)
      return res.status(400).json({
        error: 'Online payment not configured for this restaurant. Please pay at the counter.',
        fallback: 'cash'
      });

    const rzp   = getRazorpay(bill.razorpay_key_id, bill.razorpay_key_secret);
    const paise = amount_paise || Math.round(+bill.total * 100);

    const order = await rzp.orders.create({
      amount:   paise,
      currency: 'INR',
      receipt:  bill.bill_number,
      notes:    { bill_id, restaurant_id: bill.restaurant_id },
    });

    // Store pending payment
    await pool.query(`
      INSERT INTO payments (bill_id, restaurant_id, razorpay_order_id, amount, status)
      VALUES ($1, $2, $3, $4, 'created')
      ON CONFLICT (razorpay_order_id) DO NOTHING
    `, [bill_id, bill.restaurant_id, order.id, paise / 100]);

    res.json({
      data: {
        order_id:        order.id,
        amount:          order.amount,
        currency:        'INR',
        key_id:          bill.razorpay_key_id,
        bill_number:     bill.bill_number,
        restaurant_name: bill.restaurant_name,
      }
    });
  } catch (err) { next(err); }
};

// ── POST /payments/public/verify ─────────────────────────────
// Called after Razorpay popup closes with success
// Verifies HMAC, marks bill paid, sends WhatsApp receipt
exports.publicVerifyPayment = async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      bill_id,
      method,
      discount_pct,
      final_amount,
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !bill_id)
      return res.status(400).json({ error: 'Missing required payment fields' });

    // Get restaurant key secret via bill_id
    const { rows: [row] } = await client.query(`
      SELECT b.*, r.razorpay_key_secret, r.name AS restaurant_name,
             r.gstin, r.address, r.phone AS rest_phone,
             r.google_review_url, r.honest_review_mode
      FROM bills b JOIN restaurants r ON r.id = b.restaurant_id
      WHERE b.id = $1
    `, [bill_id]);

    if (!row) return res.status(404).json({ error: 'Bill not found' });

    // Verify HMAC signature
    const body   = razorpay_order_id + '|' + razorpay_payment_id;
    const digest = crypto.createHmac('sha256', row.razorpay_key_secret)
                         .update(body).digest('hex');

    if (digest !== razorpay_signature) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Payment verification failed — possible tampering' });
    }

    const paidAmount = final_amount || row.total;

    // Update payment record
    await client.query(`
      UPDATE payments
      SET razorpay_payment_id=$1, razorpay_signature=$2,
          status='captured', method=$3, captured_at=NOW()
      WHERE razorpay_order_id=$4
    `, [razorpay_payment_id, razorpay_signature, method || 'upi', razorpay_order_id]);

    // Mark bill paid with discount info
    const { rows: [bill] } = await client.query(`
      UPDATE bills
      SET status='paid', paid_at=NOW(),
          discount_pct=COALESCE($1, discount_pct),
          final_amount=$2
      WHERE id=$3
      RETURNING *,
        (SELECT table_number FROM restaurant_tables WHERE id=bills.table_id) AS table_number
    `, [discount_pct || null, paidAmount, bill_id]);

    // Free the table
    if (bill.table_id) {
      await client.query(
        `UPDATE restaurant_tables SET status='dirty', current_bill_id=NULL WHERE id=$1`,
        [bill.table_id]
      );
    }

    // Update customer stats
    if (bill.customer_id) {
      await client.query(`
        UPDATE customers
        SET visit_count=visit_count+1, total_spent=total_spent+$1, last_visit_at=NOW()
        WHERE id=$2
      `, [paidAmount, bill.customer_id]);
    }

    await client.query('COMMIT');
    logger.info(`Public payment: ${razorpay_payment_id} | ₹${paidAmount} | Bill ${bill.bill_number}`);

    // ── WhatsApp receipt (async, non-blocking) ─────────────────
    if (bill.customer_phone) {
      const discLine = discount_pct > 0
        ? `\n🎁 Google review discount: -${discount_pct}% (-₹${Math.round(row.total * discount_pct / 100)})`
        : '';
      // Rich GST receipt with itemised breakdown
      const restaurantData = {
        name:       row.restaurant_name,
        address:    row.address     || '',
        gstin:      row.gstin       || null,
        owner_name: row.owner_name  || 'Team',
      };
      const paymentData = {
        payment_id: razorpay_payment_id,
        method:     method || 'upi',
      };
      const billWithItems = {
        ...bill,
        items:        row.items || [],
        subtotal:     row.subtotal || row.total,
        restaurant_id: row.restaurant_id,
      };
      sendPaymentReceipt(billWithItems, paymentData, restaurantData, discount_pct || 0)
        .catch(e => logger.warn('Receipt WA failed:', e.message));
    }

    res.json({
      data: {
        success:      true,
        payment_id:   razorpay_payment_id,
        bill_number:  bill.bill_number,
        amount:       paidAmount,
        restaurant_name: row.restaurant_name,
        gstin:        row.gstin,
        table_number: bill.table_number,
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ── POST /payments/public/cash ────────────────────────────────
// Customer selects "Pay at counter" — just records intent
exports.publicCashIntent = async (req, res, next) => {
  try {
    const { bill_id } = req.body;
    if (!bill_id) return res.status(400).json({ error: 'bill_id required' });

    const { rows: [bill] } = await pool.query(
      'SELECT id, bill_number, total, restaurant_id FROM bills WHERE id=$1', [bill_id]
    );
    if (!bill) return res.status(404).json({ error: 'Bill not found' });

    // Just log the intent — cashier will mark paid manually
    await pool.query(`
      INSERT INTO payments (bill_id, restaurant_id, amount, method, status)
      VALUES ($1,$2,$3,'cash','pending')
      ON CONFLICT DO NOTHING
    `, [bill_id, bill.restaurant_id, bill.total]);

    res.json({ data: { success: true, bill_number: bill.bill_number, amount: bill.total } });
  } catch (err) { next(err); }
};
