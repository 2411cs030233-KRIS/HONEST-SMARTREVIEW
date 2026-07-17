// ============================================================
//  SmartReview — src/controllers/analyticsController.js
//  Advanced analytics: heatmaps, peak hours, forecasting
// ============================================================
const { pool } = require('../config/db');
const dayjs    = require('dayjs');

// ── GET /analytics/overview ───────────────────────────────────
exports.getOverview = async (req, res, next) => {
  try {
    const { restaurant_id } = req.user;
    const { branch_id, from, to } = req.query;
    const dateFrom = from || dayjs().subtract(30, 'day').format('YYYY-MM-DD');
    const dateTo   = to   || dayjs().format('YYYY-MM-DD');

    const params = [restaurant_id, dateFrom, dateTo];
    const branchFilter = branch_id ? `AND branch_id = $4` : '';
    if (branch_id) params.push(branch_id);

    const { rows: [overview] } = await pool.query(`
      SELECT
        COUNT(*)                              AS total_bills,
        COALESCE(SUM(total), 0)              AS total_revenue,
        COALESCE(AVG(total), 0)              AS avg_bill_value,
        COALESCE(AVG(f.rating), 0)           AS avg_rating,
        COUNT(CASE WHEN f.rating >= 4 THEN 1 END) AS positive_reviews,
        COUNT(CASE WHEN f.rating < 4  THEN 1 END) AS negative_reviews,
        COUNT(CASE WHEN f.google_review_done THEN 1 END) AS google_reviews,
        COUNT(CASE WHEN f.discount_unlocked THEN 1 END)  AS discounts_given,
        COALESCE(SUM(f.discount_pct * b.total / 100), 0) AS discount_amount
      FROM bills b
      LEFT JOIN feedback f ON f.bill_id = b.id
      WHERE b.restaurant_id = $1
        AND DATE(b.created_at AT TIME ZONE 'Asia/Kolkata') BETWEEN $2 AND $3
        AND b.status = 'paid'
        ${branchFilter}
    `, params);

    res.json({ data: overview });
  } catch (err) { next(err); }
};

// ── GET /analytics/revenue-chart  (daily) ────────────────────
exports.getRevenueChart = async (req, res, next) => {
  try {
    const { restaurant_id } = req.user;
    const { days = 30, branch_id } = req.query;
    const params = [restaurant_id, +days];
    const branchFilter = branch_id ? `AND b.branch_id = $3` : '';
    if (branch_id) params.push(branch_id);

    const { rows } = await pool.query(`
      SELECT
        DATE(b.created_at AT TIME ZONE 'Asia/Kolkata') AS date,
        COUNT(*)::int                                   AS bills,
        COALESCE(SUM(b.total), 0)                      AS revenue,
        ROUND(AVG(b.total)::numeric, 2)                AS avg_bill,
        ROUND(AVG(f.rating)::numeric, 2)               AS avg_rating
      FROM bills b
      LEFT JOIN feedback f ON f.bill_id = b.id
      WHERE b.restaurant_id = $1
        AND b.created_at >= NOW() - ($2 || ' days')::INTERVAL
        AND b.status = 'paid'
        ${branchFilter}
      GROUP BY 1
      ORDER BY 1 ASC
    `, params);

    res.json({ data: rows });
  } catch (err) { next(err); }
};

// ── GET /analytics/heatmap  (day-of-week × hour) ─────────────
exports.getHeatmap = async (req, res, next) => {
  try {
    const { restaurant_id } = req.user;
    const { days = 90, metric = 'revenue', branch_id } = req.query;
    // metric: 'revenue' | 'bills' | 'complaints'
    const params = [restaurant_id, +days];
    const branchFilter = branch_id ? `AND b.branch_id = $3` : '';
    if (branch_id) params.push(branch_id);

    const { rows } = await pool.query(`
      SELECT
        EXTRACT(DOW  FROM b.created_at AT TIME ZONE 'Asia/Kolkata')::int AS day_of_week,
        EXTRACT(HOUR FROM b.created_at AT TIME ZONE 'Asia/Kolkata')::int AS hour,
        COUNT(*)::int                           AS bill_count,
        COALESCE(SUM(b.total), 0)              AS revenue,
        ROUND(AVG(f.rating)::numeric, 2)        AS avg_rating,
        COUNT(CASE WHEN f.rating < 3 THEN 1 END)::int AS complaints
      FROM bills b
      LEFT JOIN feedback f ON f.bill_id = b.id
      WHERE b.restaurant_id = $1
        AND b.created_at >= NOW() - ($2 || ' days')::INTERVAL
        AND b.status = 'paid'
        ${branchFilter}
      GROUP BY 1, 2
      ORDER BY 1, 2
    `, params);

    // Fill missing cells with zeros for a complete 7×24 grid
    const grid = [];
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        const cell = rows.find(r => r.day_of_week === d && r.hour === h) || {
          day_of_week: d, hour: h, bill_count: 0, revenue: 0, avg_rating: null, complaints: 0
        };
        grid.push(cell);
      }
    }

    const days_labels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    res.json({ data: grid, days_labels, metric });
  } catch (err) { next(err); }
};

// ── GET /analytics/peak-hours ────────────────────────────────
exports.getPeakHours = async (req, res, next) => {
  try {
    const { restaurant_id } = req.user;
    const { days = 30 } = req.query;

    const { rows } = await pool.query(`
      SELECT
        EXTRACT(HOUR FROM b.created_at AT TIME ZONE 'Asia/Kolkata')::int AS hour,
        COUNT(*)::int                          AS bill_count,
        COALESCE(SUM(b.total), 0)             AS revenue,
        ROUND(AVG(f.rating)::numeric, 2)       AS avg_rating,
        COUNT(CASE WHEN f.rating < 3 THEN 1 END)::int AS complaint_count,
        ROUND(
          COUNT(CASE WHEN f.rating < 3 THEN 1 END)::numeric /
          NULLIF(COUNT(*)::numeric, 0) * 100, 1
        ) AS complaint_rate_pct
      FROM bills b
      LEFT JOIN feedback f ON f.bill_id = b.id
      WHERE b.restaurant_id = $1
        AND b.created_at >= NOW() - ($2 || ' days')::INTERVAL
        AND b.status = 'paid'
      GROUP BY 1
      ORDER BY 1 ASC
    `, [restaurant_id, +days]);

    // Classify hours
    const classified = rows.map(r => ({
      ...r,
      label: (() => {
        if (r.bill_count === 0) return 'quiet';
        const maxBills = Math.max(...rows.map(x => x.bill_count));
        const pct = r.bill_count / maxBills;
        if (pct >= 0.75) return 'peak';
        if (pct >= 0.4)  return 'busy';
        return 'quiet';
      })()
    }));

    // AI-style insight
    const peakHours = classified.filter(r => r.label === 'peak').map(r => r.hour);
    const worstComplaintHour = rows.reduce((a, b) => (+b.complaint_rate_pct > +a.complaint_rate_pct ? b : a), rows[0]);

    res.json({
      data: classified,
      insights: {
        peak_hours: peakHours,
        worst_complaint_hour: worstComplaintHour?.hour,
        suggestion: peakHours.length
          ? `Revenue peaks at ${peakHours.map(h=>`${h}:00`).join(', ')}. Consider adding extra staff 30 min before these windows.`
          : 'Not enough data yet.'
      }
    });
  } catch (err) { next(err); }
};

// ── GET /analytics/complaints ────────────────────────────────
exports.getComplaintAnalysis = async (req, res, next) => {
  try {
    const { restaurant_id } = req.user;
    const { days = 30 } = req.query;

    const { rows } = await pool.query(`
      SELECT
        unnest(complaints) AS complaint_type,
        COUNT(*)::int AS count
      FROM feedback
      WHERE restaurant_id = $1
        AND created_at >= NOW() - ($2 || ' days')::INTERVAL
        AND array_length(complaints, 1) > 0
      GROUP BY 1
      ORDER BY 2 DESC
    `, [restaurant_id, +days]);

    const total = rows.reduce((s, r) => s + r.count, 0);
    const enriched = rows.map(r => ({
      ...r,
      pct: total > 0 ? +((r.count / total) * 100).toFixed(1) : 0
    }));

    res.json({ data: enriched, total_complaints: total });
  } catch (err) { next(err); }
};

// ── GET /analytics/forecast ───────────────────────────────────
// Simple linear regression forecast for next 7 days
exports.getForecast = async (req, res, next) => {
  try {
    const { restaurant_id } = req.user;

    // Get last 30 days daily revenue
    const { rows } = await pool.query(`
      SELECT
        DATE(created_at AT TIME ZONE 'Asia/Kolkata') AS date,
        SUM(total)::float AS revenue
      FROM bills
      WHERE restaurant_id = $1
        AND created_at >= NOW() - INTERVAL '30 days'
        AND status = 'paid'
      GROUP BY 1
      ORDER BY 1 ASC
    `, [restaurant_id]);

    if (rows.length < 7) {
      return res.json({ data: [], message: 'Insufficient data for forecasting. Need at least 7 days of data.' });
    }

    // Simple linear regression
    const n = rows.length;
    const x = rows.map((_, i) => i);
    const y = rows.map(r => +r.revenue);
    const xMean = x.reduce((a, b) => a + b, 0) / n;
    const yMean = y.reduce((a, b) => a + b, 0) / n;
    const slope = x.reduce((s, xi, i) => s + (xi - xMean) * (y[i] - yMean), 0) /
                  x.reduce((s, xi) => s + Math.pow(xi - xMean, 2), 0);
    const intercept = yMean - slope * xMean;

    // Day-of-week seasonality multipliers (from historical data)
    const dowRevenue = {};
    rows.forEach(r => {
      const dow = new Date(r.date).getDay();
      dowRevenue[dow] = (dowRevenue[dow] || []);
      dowRevenue[dow].push(+r.revenue);
    });
    const dowMultiplier = {};
    for (let d = 0; d < 7; d++) {
      const vals = dowRevenue[d] || [];
      const avg = vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : yMean;
      dowMultiplier[d] = yMean > 0 ? avg / yMean : 1;
    }

    // Generate 7-day forecast
    const forecast = [];
    for (let i = 0; i < 7; i++) {
      const futureX  = n + i;
      const trendRev = Math.max(0, slope * futureX + intercept);
      const date     = dayjs().add(i + 1, 'day');
      const dow      = date.day();
      const forecast_revenue = Math.round(trendRev * (dowMultiplier[dow] || 1));
      const confidence = Math.max(0.5, 0.95 - i * 0.05);   // decreases further out

      forecast.push({
        date: date.format('YYYY-MM-DD'),
        day_name: date.format('ddd'),
        forecast_revenue,
        lower_bound: Math.round(forecast_revenue * (1 - (1 - confidence) * 1.5)),
        upper_bound: Math.round(forecast_revenue * (1 + (1 - confidence) * 1.5)),
        confidence: +confidence.toFixed(2)
      });
    }

    const weekTotal = forecast.reduce((s, r) => s + r.forecast_revenue, 0);
    res.json({
      data: forecast,
      summary: {
        predicted_week_revenue: weekTotal,
        trend: slope > 0 ? 'growing' : slope < 0 ? 'declining' : 'stable',
        slope_per_day: +slope.toFixed(2),
        based_on_days: n
      }
    });
  } catch (err) { next(err); }
};

// ── GET /analytics/menu-performance ──────────────────────────
exports.getMenuPerformance = async (req, res, next) => {
  try {
    const { restaurant_id } = req.user;
    const { days = 30, limit = 20 } = req.query;

    const { rows } = await pool.query(`
      SELECT
        mi.id, mi.name, mi.emoji, mc.name AS category,
        mi.price, mi.total_orders, mi.total_revenue,
        ROUND((mi.total_revenue / NULLIF(mi.total_orders,0))::numeric, 2) AS avg_revenue_per_order,
        mi.is_available,
        RANK() OVER (ORDER BY mi.total_orders DESC) AS orders_rank,
        RANK() OVER (ORDER BY mi.total_revenue DESC) AS revenue_rank
      FROM menu_items mi
      LEFT JOIN menu_categories mc ON mc.id = mi.category_id
      WHERE mi.restaurant_id = $1
      ORDER BY mi.total_orders DESC
      LIMIT $2
    `, [restaurant_id, +limit]);

    // Category breakdown
    const { rows: catRows } = await pool.query(`
      SELECT mc.name AS category, SUM(mi.total_orders) AS orders, SUM(mi.total_revenue) AS revenue
      FROM menu_items mi
      LEFT JOIN menu_categories mc ON mc.id = mi.category_id
      WHERE mi.restaurant_id = $1
      GROUP BY 1
      ORDER BY 2 DESC
    `, [restaurant_id]);

    res.json({ data: rows, categories: catRows });
  } catch (err) { next(err); }
};

// ── GET /analytics/payment-methods ───────────────────────────
exports.getPaymentMethods = async (req, res, next) => {
  try {
    const { restaurant_id } = req.user;
    const { days = 30 } = req.query;

    const { rows } = await pool.query(`
      SELECT
        COALESCE(p.method, 'unknown') AS method,
        COUNT(*)::int                  AS count,
        COALESCE(SUM(p.amount), 0)    AS revenue,
        ROUND(
          COUNT(*)::numeric / NULLIF(SUM(COUNT(*)) OVER(), 0) * 100, 1
        ) AS pct
      FROM payments p
      JOIN bills b ON b.id = p.bill_id
      WHERE b.restaurant_id = $1
        AND p.status = 'captured'
        AND p.created_at >= NOW() - ($2 || ' days')::INTERVAL
      GROUP BY 1
      ORDER BY 3 DESC
    `, [restaurant_id, +days]);

    res.json({ data: rows });
  } catch (err) { next(err); }
};

// ── GET /analytics/branch-comparison ─────────────────────────
exports.getBranchComparison = async (req, res, next) => {
  try {
    const { restaurant_id } = req.user;
    const { days = 30 } = req.query;

    const { rows } = await pool.query(`
      SELECT
        br.id, br.name, br.city,
        COUNT(b.id)::int              AS bill_count,
        COALESCE(SUM(b.total), 0)    AS revenue,
        ROUND(AVG(b.total)::numeric, 2)  AS avg_bill,
        ROUND(AVG(f.rating)::numeric, 2) AS avg_rating,
        COUNT(CASE WHEN f.google_review_done THEN 1 END)::int AS google_reviews,
        COUNT(CASE WHEN f.rating < 3 THEN 1 END)::int         AS complaints
      FROM branches br
      LEFT JOIN bills b    ON b.branch_id = br.id
                           AND b.created_at >= NOW() - ($2 || ' days')::INTERVAL
                           AND b.status = 'paid'
      LEFT JOIN feedback f ON f.bill_id = b.id
      WHERE br.restaurant_id = $1
      GROUP BY br.id, br.name, br.city
      ORDER BY revenue DESC
    `, [restaurant_id, +days]);

    res.json({ data: rows });
  } catch (err) { next(err); }
};
