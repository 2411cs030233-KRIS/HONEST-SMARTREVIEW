// ============================================================
//  src/routes/index.js  —  All route definitions
// ============================================================

// ── auth.js ──────────────────────────────────────────────────
const express      = require('express');
const authRouter   = express.Router();
const authCtrl     = require('../controllers/authController');
const { protect }  = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const Joi          = require('joi');

const registerSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  owner_name: Joi.string().min(2).max(100).required(),
  email: Joi.string().email().required(),
  phone: Joi.string().pattern(/^\+?[\d\s-]{10,15}$/).required(),
  password: Joi.string().min(8).required(),
  city: Joi.string().optional(),
  cuisine_type: Joi.string().optional(),
  table_count: Joi.number().integer().min(1).max(200).optional(),
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
});

authRouter.post('/register',        validate(registerSchema), authCtrl.register);
authRouter.post('/login',           validate(loginSchema),    authCtrl.login);
authRouter.post('/forgot-password', authCtrl.forgotPassword);
authRouter.post('/reset-password',  authCtrl.resetPassword);
authRouter.get ('/me',              protect, authCtrl.getMe);
authRouter.patch('/me',             protect, authCtrl.updateMe);
authRouter.post('/logout',          protect, authCtrl.logout);
authRouter.post('/change-password', protect, authCtrl.changePassword);
authRouter.get ('/sessions',        protect, authCtrl.getSessions);

module.exports.authRoutes = authRouter;

// ── bills.js ─────────────────────────────────────────────────
const billRouter  = express.Router();
const billCtrl    = require('../controllers/billController');

billRouter.use(protect);
billRouter.get ('/',     billCtrl.getBills);
billRouter.post('/',     billCtrl.createBill);
billRouter.get ('/:id',  billCtrl.getBillById);
billRouter.patch('/:id/status', billCtrl.updateBillStatus);

module.exports.billRoutes = billRouter;

// ── payments.js ───────────────────────────────────────────────
const payRouter = express.Router();
const payCtrl   = require('../controllers/paymentController');

// ── PUBLIC routes (no auth — called from customer QR page) ───
payRouter.post('/public/create-order', payCtrl.publicCreateOrder);
payRouter.post('/public/verify',       payCtrl.publicVerifyPayment);
payRouter.post('/public/cash',         payCtrl.publicCashIntent);

// ── PROTECTED routes (owner dashboard) ───────────────────────
payRouter.use(protect);
payRouter.post('/create-order', payCtrl.createOrder);
payRouter.post('/verify',       payCtrl.verifyPayment);
payRouter.post('/cash',         payCtrl.recordCash);
payRouter.get ('/',             payCtrl.getTransactions);

module.exports.paymentRoutes = payRouter;

// ── analytics.js ──────────────────────────────────────────────
const analRouter = express.Router();
const analCtrl   = require('../controllers/analyticsController');
const { requirePlan } = require('../middleware/auth');

analRouter.use(protect);
analRouter.get('/overview',          analCtrl.getOverview);
analRouter.get('/revenue-chart',     analCtrl.getRevenueChart);
analRouter.get('/heatmap',           requirePlan('premium','pro'), analCtrl.getHeatmap);
analRouter.get('/peak-hours',        requirePlan('premium','pro'), analCtrl.getPeakHours);
analRouter.get('/complaints',        analCtrl.getComplaintAnalysis);
analRouter.get('/forecast',          requirePlan('premium','pro'), analCtrl.getForecast);
analRouter.get('/menu-performance',  analCtrl.getMenuPerformance);
analRouter.get('/payment-methods',   analCtrl.getPaymentMethods);
analRouter.get('/branch-comparison', requirePlan('pro'),           analCtrl.getBranchComparison);

module.exports.analyticsRoutes = analRouter;

// ── feedback.js ───────────────────────────────────────────────
const fbRouter = express.Router();

// Public — called from customer QR page (no auth needed)
fbRouter.post('/submit', async (req, res, next) => {
  const client = await require('../config/db').pool.connect();
  try {
    await client.query('BEGIN');
    const { bill_id, rating, complaints = [], comment, google_review_done } = req.body;

    const { rows: [bill] } = await client.query(
      'SELECT * FROM bills WHERE id=$1', [bill_id]
    );
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    if (bill.status === 'paid') return res.status(400).json({ error: 'Bill already closed' });

    const discountPct = rating === 5 ? 5 : rating === 4 ? 4 : 0;
    const discountUnlocked = google_review_done && rating >= 4;

    // Upsert feedback
    const { rows: [fb] } = await client.query(`
      INSERT INTO feedback (bill_id, restaurant_id, branch_id, customer_id, rating, complaints, comment, google_review_done, google_review_at, discount_unlocked, discount_pct, table_number)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8 THEN NOW() ELSE NULL END,$9,$10,
              (SELECT table_number FROM restaurant_tables WHERE id=$11))
      ON CONFLICT (bill_id) DO UPDATE
        SET google_review_done=$8, discount_unlocked=$9, discount_pct=$10, google_review_at=CASE WHEN $8 THEN NOW() ELSE feedback.google_review_at END
      RETURNING *
    `, [bill_id, bill.restaurant_id, bill.branch_id, bill.customer_id, rating,
        complaints, comment, google_review_done, discountUnlocked, discountPct, bill.table_id]);

    // Apply discount to bill
    if (discountUnlocked && discountPct > 0) {
      const discAmt = +(bill.total * (discountPct / 100)).toFixed(2);
      await client.query(
        'UPDATE bills SET discount_pct=$1, discount_amt=$2, total=total-$2 WHERE id=$3',
        [discountPct, discAmt, bill_id]
      );
    }

    // Update customer avg rating
    if (bill.customer_id) {
      await client.query(`
        UPDATE customers SET avg_rating=(
          SELECT AVG(rating) FROM feedback WHERE customer_id=$1
        ) WHERE id=$1
      `, [bill.customer_id]);
    }

    await client.query('COMMIT');
    res.json({ data: { ...fb, discount_pct: discountPct, discount_unlocked: discountUnlocked } });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// Protected — owner views
fbRouter.get('/', protect, async (req, res, next) => {
  try {
    const { restaurant_id } = req.user;
    const { page=1, limit=20, rating, from, to } = req.query;
    const offset = (page-1)*limit;
    const params = [restaurant_id];
    const conds = ['f.restaurant_id=$1'];
    if (rating) { params.push(+rating); conds.push(`f.rating=$${params.length}`); }
    if (from)   { params.push(from);    conds.push(`f.created_at>=$${params.length}`); }
    if (to)     { params.push(to);      conds.push(`f.created_at<=$${params.length}`); }

    const { rows } = await require('../config/db').pool.query(`
      SELECT f.*, b.bill_number, b.total, b.customer_phone,
             rt.table_number, c.name AS customer_name
      FROM feedback f
      JOIN bills b ON b.id=f.bill_id
      LEFT JOIN restaurant_tables rt ON rt.id=b.table_id
      LEFT JOIN customers c ON c.id=f.customer_id
      WHERE ${conds.join(' AND ')}
      ORDER BY f.created_at DESC
      LIMIT $${params.length+1} OFFSET $${params.length+2}
    `, [...params, limit, offset]);

    res.json({ data: rows });
  } catch(err){ next(err); }
});

module.exports.feedbackRoutes = fbRouter;

// ── menu.js ────────────────────────────────────────────────────
const menuRouter = express.Router();
menuRouter.use(protect);

menuRouter.get('/', async (req,res,next)=>{
  try {
    const { rows } = await require('../config/db').pool.query(`
      SELECT mi.*, mc.name AS category_name FROM menu_items mi
      LEFT JOIN menu_categories mc ON mc.id=mi.category_id
      WHERE mi.restaurant_id=$1 ORDER BY mc.display_order, mi.display_order, mi.name
    `, [req.user.restaurant_id]);
    res.json({ data: rows });
  } catch(e){ next(e); }
});

menuRouter.post('/', async (req,res,next)=>{
  try {
    const { name, price, category_id, emoji, description, is_veg, prep_time_min } = req.body;
    const { rows:[item] } = await require('../config/db').pool.query(`
      INSERT INTO menu_items (restaurant_id, category_id, name, price, emoji, description, is_veg, prep_time_min)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [req.user.restaurant_id, category_id, name, price, emoji, description, is_veg, prep_time_min]);
    res.status(201).json({ data: item });
  } catch(e){ next(e); }
});

menuRouter.patch('/:id', async (req,res,next)=>{
  try {
    const { name, price, emoji, description, is_available, is_veg } = req.body;
    const { rows:[item] } = await require('../config/db').pool.query(`
      UPDATE menu_items SET name=COALESCE($1,name), price=COALESCE($2,price),
        emoji=COALESCE($3,emoji), description=COALESCE($4,description),
        is_available=COALESCE($5,is_available), is_veg=COALESCE($6,is_veg), updated_at=NOW()
      WHERE id=$7 AND restaurant_id=$8 RETURNING *
    `, [name,price,emoji,description,is_available,is_veg,req.params.id,req.user.restaurant_id]);
    if (!item) return res.status(404).json({ error:'Item not found' });
    res.json({ data: item });
  } catch(e){ next(e); }
});

menuRouter.delete('/:id', async (req,res,next)=>{
  try {
    await require('../config/db').pool.query(
      'DELETE FROM menu_items WHERE id=$1 AND restaurant_id=$2',
      [req.params.id, req.user.restaurant_id]
    );
    res.json({ message:'Item deleted' });
  } catch(e){ next(e); }
});

module.exports.menuRoutes = menuRouter;

// ── tables.js ─────────────────────────────────────────────────
const tableRouter = express.Router();
tableRouter.use(protect);

tableRouter.get('/', async (req,res,next)=>{
  try {
    const { branch_id } = req.query;
    const params = [req.user.restaurant_id];
    let q = `SELECT rt.*, br.name AS branch_name FROM restaurant_tables rt
             JOIN branches br ON br.id=rt.branch_id WHERE br.restaurant_id=$1`;
    if (branch_id) { params.push(branch_id); q += ` AND rt.branch_id=$2`; }
    q += ' ORDER BY rt.table_number';
    const { rows } = await require('../config/db').pool.query(q, params);
    res.json({ data: rows });
  } catch(e){ next(e); }
});

tableRouter.patch('/:id/status', async (req,res,next)=>{
  try {
    const { status } = req.body;
    const valid = ['free','occupied','billing','dirty','reserved'];
    if (!valid.includes(status)) return res.status(400).json({ error:'Invalid status' });
    const { rows:[t] } = await require('../config/db').pool.query(`
      UPDATE restaurant_tables SET status=$1,
        occupied_since=CASE WHEN $1='occupied' THEN NOW() ELSE occupied_since END,
        current_bill_id=CASE WHEN $1='free' OR $1='dirty' THEN NULL ELSE current_bill_id END
      WHERE id=$2 RETURNING *
    `, [status, req.params.id]);
    if (!t) return res.status(404).json({ error:'Table not found' });
    res.json({ data: t });
  } catch(e){ next(e); }
});

module.exports.tableRoutes = tableRouter;

// ── whatsapp.js ───────────────────────────────────────────────
const waRouter = express.Router();
waRouter.use(protect);
const waSvc = require('../services/whatsappService');

waRouter.post('/send', async (req,res,next)=>{
  try {
    const { phone, message, customer_id } = req.body;
    await waSvc.sendWhatsApp(phone, message, req.user.restaurant_id, customer_id);
    res.json({ message:'Sent' });
  } catch(e){ next(e); }
});

waRouter.post('/campaign', async (req,res,next)=>{
  try {
    const { segment, template, offer_text } = req.body;
    const result = await waSvc.sendCampaign(req.user.restaurant_id, segment, template, offer_text);
    res.json({ data: result });
  } catch(e){ next(e); }
});

waRouter.get('/messages', async (req,res,next)=>{
  try {
    const { rows } = await require('../config/db').pool.query(`
      SELECT wm.*, c.name AS customer_name FROM whatsapp_messages wm
      LEFT JOIN customers c ON c.id=wm.customer_id
      WHERE wm.restaurant_id=$1 ORDER BY wm.created_at DESC LIMIT 50
    `, [req.user.restaurant_id]);
    res.json({ data: rows });
  } catch(e){ next(e); }
});

module.exports.waRoutes = waRouter;

// ── reports.js ────────────────────────────────────────────────
const reportRouter = express.Router();
reportRouter.use(protect, requirePlan('premium','pro'));

reportRouter.post('/send-now', async (req,res,next)=>{
  try {
    const { type } = req.body;
    const { restaurant_id, name } = req.user;
    const { rows:[restaurant] } = await require('../config/db').pool.query(
      'SELECT whatsapp_no FROM restaurants WHERE id=$1', [restaurant_id]
    );
    if (!restaurant.whatsapp_no) return res.status(400).json({ error:'No WhatsApp number configured' });

    const { rows:[stats] } = await require('../config/db').pool.query(`
      SELECT COUNT(*)::int AS total_bills, SUM(total) AS total_revenue,
             AVG(total) AS avg_bill_value, AVG(f.rating) AS avg_rating,
             COUNT(CASE WHEN f.google_review_done THEN 1 END) AS google_reviews,
             COUNT(CASE WHEN f.rating < 3 THEN 1 END) AS negative_reviews
      FROM bills b LEFT JOIN feedback f ON f.bill_id=b.id
      WHERE b.restaurant_id=$1 AND DATE(b.created_at AT TIME ZONE 'Asia/Kolkata')=CURRENT_DATE
        AND b.status='paid'
    `, [restaurant_id]);

    await waSvc.sendDailyReport(restaurant.whatsapp_no, stats, name);
    res.json({ message:'Report sent to ' + restaurant.whatsapp_no });
  } catch(e){ next(e); }
});

module.exports.reportRoutes = reportRouter;

// ── feedback.js (extended) ──────────────────────────────────────
const feedbackCtrl = require('../controllers/feedbackController');
fbRouter.get('/summary', protect, feedbackCtrl.getFeedbackSummary);
// NOTE: the inline /submit and / routes above remain primary; these controller
// versions supersede them (cross-checked for parity) for cleaner separation.

// ── menu.js (extended) — categories + public menu ────────────────
const menuCtrl = require('../controllers/menuController');
menuRouter.get('/categories', menuCtrl.getCategories);
menuRouter.post('/categories', menuCtrl.createCategory);
menuRouter.patch('/categories/:id', menuCtrl.updateCategory);
menuRouter.delete('/categories/:id', menuCtrl.deleteCategory);
menuRouter.patch('/:id/toggle-availability', menuCtrl.toggleAvailability);

const publicMenuRouter = express.Router();
publicMenuRouter.get('/:slug', menuCtrl.getPublicMenu);
module.exports.publicMenuRoutes = publicMenuRouter;

// ── staff.js ──────────────────────────────────────────────────────
const staffRouter = express.Router();
const staffCtrl   = require('../controllers/staffController');

staffRouter.post('/login', staffCtrl.staffLogin); // staff PIN login, no JWT needed
staffRouter.use(protect);
staffRouter.get   ('/',                     staffCtrl.getStaff);
staffRouter.post  ('/',                     staffCtrl.createStaff);
staffRouter.patch ('/:id',                  staffCtrl.updateStaff);
staffRouter.delete('/:id',                  staffCtrl.deleteStaff);
staffRouter.get   ('/performance',          staffCtrl.getPerformance);
staffRouter.get   ('/table-assignments',    staffCtrl.getTableAssignments);
staffRouter.post  ('/assign-table',         staffCtrl.assignTable);
staffRouter.get   ('/shifts',               staffCtrl.getShifts);
staffRouter.patch ('/:id/shift',            staffCtrl.updateShift);

module.exports.staffRoutes = staffRouter;

// ── inventory.js ──────────────────────────────────────────────────
const inventoryRouter = express.Router();
const invCtrl = require('../controllers/inventoryController');

inventoryRouter.use(protect);
inventoryRouter.get   ('/',                  invCtrl.getInventory);
inventoryRouter.get   ('/alerts',            invCtrl.getLowStockAlerts);
inventoryRouter.get   ('/suppliers',         invCtrl.getSuppliers);
inventoryRouter.get   ('/transactions',      invCtrl.getTransactions);
inventoryRouter.post  ('/',                  invCtrl.createItem);
inventoryRouter.patch ('/:id',               invCtrl.updateItem);
inventoryRouter.delete('/:id',               invCtrl.deleteItem);
inventoryRouter.post  ('/:id/transaction',   invCtrl.recordTransaction);

module.exports.inventoryRoutes = inventoryRouter;

// ── reports.js (extended with full controller) ────────────────────
const reportCtrl = require('../controllers/reportController');
reportRouter.get ('/preview',   reportCtrl.previewReport);
reportRouter.post('/send-now',  reportCtrl.sendNow); // supersedes inline version above
reportRouter.get ('/schedules', reportCtrl.getSchedules);
reportRouter.post('/schedules', reportCtrl.upsertSchedule);
reportRouter.get ('/history',   reportCtrl.getHistory);

// ── loyalty.js ────────────────────────────────────────────────
const loyaltyRouter = express.Router();
const loyaltyCtrl   = require('../controllers/loyaltyController');

// Public route (customer QR page)
loyaltyRouter.get('/customer/by-phone/:phone', loyaltyCtrl.getLoyaltyByPhone);
loyaltyRouter.get('/rewards-public',           loyaltyCtrl.getRewards);

// Protected routes (owner)
loyaltyRouter.use(protect);
loyaltyRouter.get ('/customer/:id',   loyaltyCtrl.getCustomerLoyalty);
loyaltyRouter.get ('/rewards',        loyaltyCtrl.getRewards);
loyaltyRouter.post('/rewards',        loyaltyCtrl.createReward);
loyaltyRouter.patch('/rewards/:id',   loyaltyCtrl.updateReward);
loyaltyRouter.post('/redeem',         loyaltyCtrl.redeemReward);
loyaltyRouter.get ('/tiers',          loyaltyCtrl.getTiers);
loyaltyRouter.patch('/tiers/:tier',   loyaltyCtrl.updateTier);
loyaltyRouter.get ('/leaderboard',    loyaltyCtrl.getLeaderboard);

module.exports.loyaltyRoutes = loyaltyRouter;

// ── webhooks.js ───────────────────────────────────────────────
const webhookRouter = express.Router();
const { createHmac } = require('crypto');

// Razorpay webhook — verify signature and update bill status
webhookRouter.post('/razorpay', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const body      = req.body;
    const signature = req.headers['x-razorpay-signature'];
    const secret    = process.env.RAZORPAY_WEBHOOK_SECRET || '';

    const expected = createHmac('sha256', secret)
      .update(body)
      .digest('hex');

    if (signature !== expected) {
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    const event = JSON.parse(body);
    if (event.event === 'payment.captured') {
      const orderId = event.payload.payment.entity.order_id;
      await require('../config/db').pool.query(
        `UPDATE bills SET status='paid', paid_at=NOW()
         WHERE razorpay_order_id=$1 AND status!='paid'`,
        [orderId]
      );
    }
    res.json({ received: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports.webhookRoutes = webhookRouter;

// ── HONEST REVIEW MODE routes (extend existing fbRouter) ──────
fbRouter.get ('/unresolved',       protect, feedbackCtrl.getUnresolved);
fbRouter.post('/:id/resolve',      protect, feedbackCtrl.resolveComplaint);
fbRouter.get ('/resolution-stats', protect, feedbackCtrl.getResolutionStats);
fbRouter.post('/coupon/redeem',             feedbackCtrl.redeemCoupon);   // public

// ── Honest mode toggle on restaurant settings ─────────────────
authRouter.patch('/honest-review-mode', protect, feedbackCtrl.toggleHonestMode);
