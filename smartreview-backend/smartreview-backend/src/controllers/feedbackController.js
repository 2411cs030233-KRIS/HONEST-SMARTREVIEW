// ============================================================
//  src/controllers/feedbackController.js
//  Public feedback submission + owner-side feedback inbox
// ============================================================
const { pool } = require('../config/db');
const logger   = require('../utils/logger');
const { sendWhatsApp, sendComplaintAlert } = require('../services/whatsappService');

// ── POST /feedback/submit  (PUBLIC — no auth, called from customer QR page) ──
exports.submitFeedback = async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { bill_id, rating, complaints = [], comment, google_review_done } = req.body;

    if (!bill_id || !rating) throw { status: 400, message: 'bill_id and rating are required' };
    if (rating < 1 || rating > 5) throw { status: 400, message: 'rating must be between 1 and 5' };

    const { rows: [bill] } = await client.query('SELECT * FROM bills WHERE id = $1', [bill_id]);
    if (!bill) throw { status: 404, message: 'Bill not found' };
    if (bill.status === 'paid') throw { status: 400, message: 'Feedback already finalized for this bill' };

    // Discount logic: 5★ = 5%, 4★ = 4%, anything else = 0% (and never without a Google review)
    const discountPct = rating === 5 ? 5 : rating === 4 ? 4 : 0;
    const discountUnlocked = Boolean(google_review_done) && rating >= 4;

    const { rows: [tableRow] } = await client.query(
      'SELECT table_number FROM restaurant_tables WHERE id = $1', [bill.table_id]
    );

    const { rows: [fb] } = await client.query(`
      INSERT INTO feedback (
        bill_id, restaurant_id, branch_id, customer_id, rating,
        complaints, comment, google_review_done, google_review_at,
        discount_unlocked, discount_pct, table_number
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,
        CASE WHEN $8 THEN NOW() ELSE NULL END,
        $9,$10,$11
      )
      ON CONFLICT (bill_id) DO UPDATE SET
        rating = EXCLUDED.rating,
        complaints = EXCLUDED.complaints,
        comment = EXCLUDED.comment,
        google_review_done = EXCLUDED.google_review_done,
        google_review_at = CASE WHEN EXCLUDED.google_review_done THEN NOW() ELSE feedback.google_review_at END,
        discount_unlocked = EXCLUDED.discount_unlocked,
        discount_pct = EXCLUDED.discount_pct
      RETURNING *
    `, [
      bill_id, bill.restaurant_id, bill.branch_id, bill.customer_id, rating,
      complaints, comment, !!google_review_done,
      discountUnlocked, discountUnlocked ? discountPct : 0,
      tableRow?.table_number || null,
    ]);

    // Apply discount to the bill total if unlocked
    if (discountUnlocked && discountPct > 0 && bill.discount_pct === 0) {
      const discAmt = +(bill.subtotal * (discountPct / 100)).toFixed(2);
      await client.query(
        `UPDATE bills SET discount_pct = $1, discount_amt = $2, total = total - $2 WHERE id = $3`,
        [discountPct, discAmt, bill_id]
      );
    }

    // Update customer's running average rating
    if (bill.customer_id) {
      await client.query(`
        UPDATE customers
        SET avg_rating = (SELECT ROUND(AVG(rating)::numeric, 2) FROM feedback WHERE customer_id = $1)
        WHERE id = $1
      `, [bill.customer_id]);
    }

    await client.query('COMMIT');
    logger.info(`Feedback submitted: bill ${bill_id} | ${rating}★ | review=${!!google_review_done}`);

    // Notify owner of low ratings instantly — rich format with all complaint details
    if (rating <= 3) {
      pool.query(
        'SELECT whatsapp_no, name FROM restaurants WHERE id = $1',
        [bill.restaurant_id]
      ).then(({ rows: [r] }) => {
        if (r?.whatsapp_no) {
          const billWithDetails = {
            ...bill,
            table_number: tableRow?.table_number || null,
            comment: comment || null,
          };
          sendComplaintAlert(r.whatsapp_no, billWithDetails, rating, complaints, r.name)
            .catch(e => logger.warn('Owner complaint alert WA failed:', e.message));
        }
      }).catch(() => {});
    }

    res.json({
      data: {
        ...fb,
        discount_pct: discountUnlocked ? discountPct : 0,
        discount_unlocked: discountUnlocked,
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ── GET /feedback  (owner inbox, protected) ───────────────────
exports.getFeedback = async (req, res, next) => {
  try {
    const { restaurant_id } = req.user;
    const { rating, branch_id, from, to, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const params = [restaurant_id];
    const conds = ['f.restaurant_id = $1'];

    if (rating)    { params.push(+rating);   conds.push(`f.rating = $${params.length}`); }
    if (branch_id) { params.push(branch_id); conds.push(`f.branch_id = $${params.length}`); }
    if (from)      { params.push(from);      conds.push(`f.created_at >= $${params.length}`); }
    if (to)        { params.push(to);        conds.push(`f.created_at <= $${params.length}`); }

    const { rows } = await pool.query(`
      SELECT f.*, b.bill_number, b.total, b.customer_phone,
             c.name AS customer_name
      FROM feedback f
      JOIN bills b ON b.id = f.bill_id
      LEFT JOIN customers c ON c.id = f.customer_id
      WHERE ${conds.join(' AND ')}
      ORDER BY f.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*) FROM feedback f WHERE ${conds.join(' AND ')}`, params
    );

    res.json({ data: rows, pagination: { page: +page, limit: +limit, total: +count } });
  } catch (err) { next(err); }
};

// ── GET /feedback/summary  (quick stats for dashboard) ─────────
exports.getFeedbackSummary = async (req, res, next) => {
  try {
    const { restaurant_id } = req.user;
    const { rows: [summary] } = await pool.query(`
      SELECT
        COUNT(*)::int AS total_feedback,
        ROUND(AVG(rating)::numeric, 2) AS avg_rating,
        COUNT(CASE WHEN rating >= 4 THEN 1 END)::int AS positive_count,
        COUNT(CASE WHEN rating < 4 THEN 1 END)::int AS negative_count,
        COUNT(CASE WHEN google_review_done THEN 1 END)::int AS google_reviews_count,
        COUNT(CASE WHEN discount_unlocked THEN 1 END)::int AS discounts_unlocked
      FROM feedback
      WHERE restaurant_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
    `, [restaurant_id]);
    res.json({ data: summary });
  } catch (err) { next(err); }
};

// ============================================================
//  HONEST REVIEW MODE — New endpoints (extends existing file)
//  Never rewrote existing code — only appended below
// ============================================================

// ── GET /feedback/unresolved  (owner sees pending complaints) ─
// Returns only 1-3★ complaints not yet resolved
exports.getUnresolved = async (req, res, next) => {
  try {
    const { restaurant_id } = req.user;
    const { rows } = await pool.query(`
      SELECT
        f.id, f.rating, f.complaints, f.comment,
        f.created_at, f.resolved, f.coupon_code,
        f.table_number,
        b.bill_number, b.total, b.customer_phone,
        c.name AS customer_name,
        EXTRACT(DAY FROM NOW() - f.created_at)::int AS days_pending
      FROM feedback f
      JOIN bills b ON b.id = f.bill_id
      LEFT JOIN customers c ON c.id = f.customer_id
      WHERE f.restaurant_id = $1
        AND f.rating <= 3
        AND f.resolved = FALSE
      ORDER BY f.created_at ASC
    `, [restaurant_id]);

    res.json({ data: rows, count: rows.length });
  } catch (err) { next(err); }
};

// ── POST /feedback/:id/resolve  (owner marks complaint resolved) ─
// This triggers the WhatsApp message to the customer
exports.resolveComplaint = async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { id } = req.params;
    const { restaurant_id } = req.user;
    const { resolution_note } = req.body;

    // Fetch feedback + customer info + restaurant info
    const { rows: [fb] } = await client.query(`
      SELECT
        f.*,
        b.customer_phone, b.total AS bill_total,
        c.name AS customer_name, c.id AS customer_id,
        r.name AS restaurant_name, r.owner_name,
        r.honest_review_mode,
        r.google_review_url
      FROM feedback f
      JOIN bills b ON b.id = f.bill_id
      LEFT JOIN customers c ON c.id = f.customer_id
      JOIN restaurants r ON r.id = f.restaurant_id
      WHERE f.id = $1
        AND f.restaurant_id = $2
        AND f.rating <= 3
    `, [id, restaurant_id]);

    if (!fb) return res.status(404).json({ error: 'Complaint not found or already resolved' });
    if (fb.resolved) return res.status(400).json({ error: 'Complaint already resolved' });
    if (!fb.customer_phone && !fb.b_customer_phone) {
      return res.status(400).json({ error: 'Customer has no phone number — cannot send WhatsApp' });
    }

    // Generate unique coupon code
    const { rows: [couponRow] } = await client.query(
      `SELECT generate_coupon_code($1::uuid, $2::uuid) AS code`,
      [restaurant_id, id]
    );
    const couponCode = couponRow.code;

    // Mark feedback as resolved
    await client.query(`
      UPDATE feedback SET
        resolved = TRUE,
        resolved_at = NOW(),
        resolved_by = $1,
        resolution_note = $2,
        coupon_code = $3,
        wa_resolution_sent = FALSE
      WHERE id = $4
    `, [req.user.restaurant_id, resolution_note || null, couponCode, id]);

    // Log in complaint_resolutions table
    await client.query(`
      INSERT INTO complaint_resolutions
        (feedback_id, restaurant_id, resolved_by, resolution_note, coupon_code, coupon_pct)
      VALUES ($1, $2, $3, $4, $5, 3)
    `, [id, restaurant_id, req.user.restaurant_id, resolution_note || null, couponCode]);

    await client.query('COMMIT');

    // Build the complaint list for the WhatsApp message
    const complaintList = (fb.complaints || []).join(', ') || 'your concern';
    const customerName  = fb.customer_name ? fb.customer_name.split(' ')[0] : 'there';
    const phone         = fb.customer_phone;

    // WhatsApp message — personal, warm, specific
    const message = `Hi ${customerName}! 👋

This is *${fb.restaurant_name}*.

We wanted to personally reach out to you.

During your recent visit, you shared feedback about *${complaintList}*. We took your concern very seriously.

✅ We have identified the issue and worked hard to fix it. We promise this will not happen again.

We truly value your feedback — it helps us become better. 🙏

We humbly request a second chance to serve you and show you the experience you deserve.

*Use code ${couponCode} for 3% off on your next visit.*

We look forward to welcoming you again!

— ${fb.owner_name || 'The Team'}, ${fb.restaurant_name}`;

    // Send WhatsApp (async, non-blocking)
    sendWhatsApp(phone, message, restaurant_id, fb.customer_id, 'resolution')
      .then(async () => {
        await pool.query(`
          UPDATE feedback SET wa_resolution_sent = TRUE, wa_resolution_sent_at = NOW()
          WHERE id = $1
        `, [id]);
        await pool.query(`
          UPDATE complaint_resolutions SET wa_sent = TRUE, wa_sent_at = NOW()
          WHERE feedback_id = $1
        `, [id]);
        logger.info(`Resolution WhatsApp sent to ${phone} for complaint ${id}`);
      })
      .catch(e => logger.warn('Resolution WhatsApp failed:', e.message));

    logger.info(`Complaint ${id} marked resolved by restaurant ${restaurant_id}`);
    res.json({
      message: 'Complaint resolved. WhatsApp is being sent to the customer.',
      coupon_code: couponCode,
      customer_phone: phone,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ── GET /feedback/resolution-stats  (dashboard analytics) ────
exports.getResolutionStats = async (req, res, next) => {
  try {
    const { restaurant_id } = req.user;
    const { rows: [stats] } = await pool.query(`
      SELECT
        COUNT(*)                                    ::int AS total_complaints,
        COUNT(*) FILTER (WHERE f.resolved = TRUE)  ::int AS total_resolved,
        COUNT(*) FILTER (WHERE f.resolved = FALSE) ::int AS pending,
        COUNT(*) FILTER (WHERE cr.customer_returned = TRUE) ::int AS customers_returned,
        ROUND(
          COUNT(*) FILTER (WHERE cr.customer_returned = TRUE)::numeric /
          NULLIF(COUNT(*) FILTER (WHERE f.resolved = TRUE), 0) * 100
        , 1) AS recovery_rate_pct,
        ROUND(AVG(
          EXTRACT(EPOCH FROM (f.resolved_at - f.created_at)) / 3600
        ) FILTER (WHERE f.resolved = TRUE), 1) AS avg_hours_to_resolve
      FROM feedback f
      LEFT JOIN complaint_resolutions cr ON cr.feedback_id = f.id
      WHERE f.restaurant_id = $1
        AND f.rating <= 3
        AND f.created_at >= NOW() - INTERVAL '30 days'
    `, [restaurant_id]);

    res.json({ data: stats });
  } catch (err) { next(err); }
};

// ── POST /feedback/coupon/redeem  (PUBLIC — customer redeems coupon at billing) ─
exports.redeemCoupon = async (req, res, next) => {
  try {
    const { coupon_code, restaurant_id } = req.body;
    if (!coupon_code || !restaurant_id)
      return res.status(400).json({ error: 'coupon_code and restaurant_id required' });

    const { rows: [fb] } = await pool.query(`
      SELECT f.id, f.coupon_code, f.coupon_redeemed, f.rating, f.resolved,
             r.name AS restaurant_name
      FROM feedback f
      JOIN restaurants r ON r.id = f.restaurant_id
      WHERE UPPER(f.coupon_code) = UPPER($1)
        AND f.restaurant_id = $2
    `, [coupon_code.trim(), restaurant_id]);

    if (!fb)              return res.status(404).json({ error: 'Invalid coupon code' });
    if (!fb.resolved)     return res.status(400).json({ error: 'Coupon not active yet — complaint not resolved' });
    if (fb.coupon_redeemed) return res.status(400).json({ error: 'Coupon already used' });

    // Mark redeemed
    await pool.query(`
      UPDATE feedback SET coupon_redeemed = TRUE, coupon_redeemed_at = NOW()
      WHERE id = $1
    `, [fb.id]);
    await pool.query(`
      UPDATE complaint_resolutions SET customer_returned = TRUE
      WHERE feedback_id = $1
    `, [fb.id]);

    res.json({
      valid: true,
      discount_pct: 3,
      message: 'Coupon valid! 3% discount applied.',
      restaurant_name: fb.restaurant_name,
    });
  } catch (err) { next(err); }
};

// ── PATCH /restaurants/honest-review-mode  (toggle the feature ON/OFF) ─
exports.toggleHonestMode = async (req, res, next) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean')
      return res.status(400).json({ error: 'enabled must be true or false' });

    await pool.query(
      'UPDATE restaurants SET honest_review_mode = $1 WHERE id = $2',
      [enabled, req.user.restaurant_id]
    );
    logger.info(`Honest Review Mode ${enabled ? 'ENABLED' : 'DISABLED'} for restaurant ${req.user.restaurant_id}`);
    res.json({ message: `Honest Review Mode ${enabled ? 'enabled' : 'disabled'}`, honest_review_mode: enabled });
  } catch (err) { next(err); }
};
