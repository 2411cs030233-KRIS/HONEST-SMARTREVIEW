// ============================================================
//  src/controllers/reportController.js
//  Automated daily/weekly report generation + WhatsApp delivery
// ============================================================
const { pool } = require('../config/db');
const logger   = require('../utils/logger');
const dayjs    = require('dayjs');
const { sendDailyReport, sendWhatsApp } = require('../services/whatsappService');

// ── Internal: build the stats payload for a date range ───────────
async function buildReportStats(restaurantId, dateFrom, dateTo) {
  const { rows: [stats] } = await pool.query(`
    SELECT
      COUNT(*)::int AS total_bills,
      COALESCE(SUM(b.total), 0) AS total_revenue,
      COALESCE(AVG(b.total), 0) AS avg_bill_value,
      ROUND(AVG(f.rating)::numeric, 2) AS avg_rating,
      COUNT(CASE WHEN f.google_review_done THEN 1 END)::int AS google_reviews,
      COUNT(CASE WHEN f.rating < 4 THEN 1 END)::int AS negative_reviews,
      (SELECT COUNT(*) FROM whatsapp_messages wm
        WHERE wm.restaurant_id = $1 AND wm.created_at BETWEEN $2 AND $3)::int AS wa_messages_sent
    FROM bills b
    LEFT JOIN feedback f ON f.bill_id = b.id
    WHERE b.restaurant_id = $1
      AND b.created_at BETWEEN $2 AND $3
      AND b.status = 'paid'
  `, [restaurantId, dateFrom, dateTo]);

  const { rows: [topItem] } = await pool.query(`
    SELECT name, emoji, total_orders FROM menu_items
    WHERE restaurant_id = $1 ORDER BY total_orders DESC LIMIT 1
  `, [restaurantId]);

  return { ...stats, top_item: topItem };
}

// ── GET /reports/preview  (preview today's stats without sending) ─
exports.previewReport = async (req, res, next) => {
  try {
    const { type = 'daily' } = req.query;
    const { restaurant_id } = req.user;

    const dateFrom = type === 'weekly' ? dayjs().subtract(7, 'day').toISOString() : dayjs().startOf('day').toISOString();
    const dateTo   = dayjs().toISOString();

    const stats = await buildReportStats(restaurant_id, dateFrom, dateTo);
    res.json({ data: stats, period: { from: dateFrom, to: dateTo, type } });
  } catch (err) { next(err); }
};

// ── POST /reports/send-now  (manual trigger) ──────────────────────
exports.sendNow = async (req, res, next) => {
  try {
    const { type = 'daily', phone } = req.body;
    const { restaurant_id, name } = req.user;

    const { rows: [restaurant] } = await pool.query(
      'SELECT whatsapp_no, name FROM restaurants WHERE id = $1', [restaurant_id]
    );
    const targetPhone = phone || restaurant.whatsapp_no;
    if (!targetPhone) return res.status(400).json({ error: 'No WhatsApp number configured. Add one in Settings or pass phone explicitly.' });

    const dateFrom = type === 'weekly' ? dayjs().subtract(7, 'day').toISOString() : dayjs().startOf('day').toISOString();
    const dateTo   = dayjs().toISOString();
    const stats = await buildReportStats(restaurant_id, dateFrom, dateTo);

    await sendDailyReport(targetPhone, stats, restaurant.name);

    // Log the send
    await pool.query(`
      UPDATE report_schedules SET last_sent_at = NOW()
      WHERE restaurant_id = $1 AND type = $2
    `, [restaurant_id, type]);

    logger.info(`Report sent manually: ${type} for ${restaurant.name} -> ${targetPhone}`);
    res.json({ message: `${type} report sent to ${targetPhone}`, data: stats });
  } catch (err) { next(err); }
};

// ── GET /reports/schedules  (current automation settings) ─────────
exports.getSchedules = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM report_schedules WHERE restaurant_id = $1 ORDER BY type',
      [req.user.restaurant_id]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
};

// ── POST /reports/schedules  (create or update automation rule) ───
exports.upsertSchedule = async (req, res, next) => {
  try {
    const { type, delivery = 'whatsapp', recipients = [], is_active = true } = req.body;
    const valid = ['daily', 'weekly', 'monthly'];
    if (!valid.includes(type)) return res.status(400).json({ error: 'type must be daily, weekly, or monthly' });

    const nextSend = type === 'daily'
      ? dayjs().hour(23).minute(0).second(0).add(dayjs().hour() >= 23 ? 1 : 0, 'day')
      : dayjs().day(8).hour(8).minute(0).second(0); // next Monday 8 AM

    const { rows: [existing] } = await pool.query(
      'SELECT id FROM report_schedules WHERE restaurant_id = $1 AND type = $2',
      [req.user.restaurant_id, type]
    );

    let schedule;
    if (existing) {
      ({ rows: [schedule] } = await pool.query(`
        UPDATE report_schedules SET delivery = $1, recipients = $2, is_active = $3, next_send_at = $4
        WHERE id = $5 RETURNING *
      `, [delivery, recipients, is_active, nextSend.toISOString(), existing.id]));
    } else {
      ({ rows: [schedule] } = await pool.query(`
        INSERT INTO report_schedules (restaurant_id, type, delivery, recipients, is_active, next_send_at)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
      `, [req.user.restaurant_id, type, delivery, recipients, is_active, nextSend.toISOString()]));
    }

    res.json({ data: schedule });
  } catch (err) { next(err); }
};

// ── GET /reports/history  (recently sent reports) ──────────────────
exports.getHistory = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM whatsapp_messages
      WHERE restaurant_id = $1 AND type = 'report'
      ORDER BY created_at DESC LIMIT 20
    `, [req.user.restaurant_id]);
    res.json({ data: rows });
  } catch (err) { next(err); }
};

// ── CRON JOB (called by node-cron in src/index.js, not a route) ───
// Runs every minute, checks for due schedules, sends, reschedules.
exports.runScheduledReports = async () => {
  try {
    const { rows: due } = await pool.query(`
      SELECT rs.*, r.whatsapp_no, r.name AS restaurant_name
      FROM report_schedules rs
      JOIN restaurants r ON r.id = rs.restaurant_id
      WHERE rs.is_active = TRUE AND rs.next_send_at <= NOW()
    `);

    for (const sched of due) {
      const target = sched.recipients?.[0] || sched.whatsapp_no;
      if (!target) continue;

      const dateFrom = sched.type === 'weekly'
        ? dayjs().subtract(7, 'day').toISOString()
        : dayjs().startOf('day').toISOString();
      const stats = await buildReportStats(sched.restaurant_id, dateFrom, dayjs().toISOString());

      await sendDailyReport(target, stats, sched.restaurant_name);

      const nextSend = sched.type === 'daily'
        ? dayjs().add(1, 'day').hour(23).minute(0)
        : dayjs().add(7, 'day').hour(8).minute(0);

      await pool.query(
        'UPDATE report_schedules SET last_sent_at = NOW(), next_send_at = $1 WHERE id = $2',
        [nextSend.toISOString(), sched.id]
      );

      logger.info(`Scheduled report sent: ${sched.type} for ${sched.restaurant_name}`);
    }
  } catch (err) {
    logger.error('runScheduledReports failed:', err);
  }
};
