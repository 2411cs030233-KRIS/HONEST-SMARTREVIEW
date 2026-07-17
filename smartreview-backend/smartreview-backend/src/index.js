// ============================================================
//  SmartReview Backend — src/index.js
//  Production-ready Express server
// ============================================================
require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const morgan      = require('morgan');
const compression = require('compression');
const rateLimit   = require('express-rate-limit');
const cron        = require('node-cron');

const { connectDB }    = require('./config/db');
const { connectRedis } = require('./config/redis');
const logger           = require('./utils/logger');
const errorHandler     = require('./middleware/errorHandler');

// ── All routes live in routes/index.js ───────────────────────
const {
  authRoutes, billRoutes, paymentRoutes, analyticsRoutes,
  feedbackRoutes, menuRoutes, staffRoutes, inventoryRoutes,
  reportRoutes, webhookRoutes, loyaltyRoutes, publicMenuRoutes,
} = require('./routes/index');

const { runScheduledReports } = require('./controllers/reportController');

const app  = express();
const PORT = process.env.PORT || 3000;
const API  = '/api/v1';

// ── Security & middleware ────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3001'],
  credentials: true,
}));
app.use(compression());
app.use(morgan('combined', { stream: { write: m => logger.info(m.trim()) } }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate limiter (skip for webhooks) ─────────────────────────
app.use((req, res, next) => {
  if (req.path.startsWith('/webhooks')) return next();
  rateLimit({ windowMs: 15 * 60 * 1000, max: 300,
    message: { error: 'Too many requests. Try again later.' },
  })(req, res, next);
});

// ── Health check ─────────────────────────────────────────────
app.get('/health', (_, res) => res.json({
  status: 'ok', version: '1.0.0',
  timestamp: new Date().toISOString(), uptime: process.uptime(),
}));

// ── API routes ────────────────────────────────────────────────
app.use(`${API}/auth`,         authRoutes);
app.use(`${API}/bills`,        billRoutes);
app.use(`${API}/payments`,     paymentRoutes);
app.use(`${API}/analytics`,    analyticsRoutes);
app.use(`${API}/feedback`,     feedbackRoutes);
app.use(`${API}/menu`,         menuRoutes);
app.use(`${API}/staff`,        staffRoutes);
app.use(`${API}/inventory`,    inventoryRoutes);
app.use(`${API}/reports`,      reportRoutes);
app.use(`${API}/loyalty`,      loyaltyRoutes);
app.use(`${API}/public-menu`,  publicMenuRoutes);
app.use('/webhooks',           webhookRoutes);

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route not found', path: req.originalUrl }));

// ── Global error handler ──────────────────────────────────────
app.use(errorHandler);

// ── Boot ──────────────────────────────────────────────────────
async function boot() {
  await connectDB();
  // await connectRedis();

  cron.schedule('* * * * *', () =>
    runScheduledReports().catch(e => logger.error('Cron failed:', e.message))
  );
  logger.info('⏰ Report scheduler started');

  app.listen(PORT, () => {
    logger.info(`🚀 SmartReview API on port ${PORT}`);
    logger.info(`📍 Health: http://localhost:${PORT}/health`);
  });
}

boot().catch(err => { logger.error('Boot failed:', err.message); process.exit(1); });
module.exports = app;
