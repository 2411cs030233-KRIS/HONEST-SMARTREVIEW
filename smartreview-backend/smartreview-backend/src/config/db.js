// src/config/db.js
const { Pool } = require('pg');
const logger   = require('../utils/logger');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     +(process.env.DB_PORT   || 5432),
  database: process.env.DB_NAME     || 'smartreview',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => logger.error('PG pool error:', err.message));

exports.pool = pool;

exports.connectDB = async () => {
  const client = await pool.connect();
  client.release();
  logger.info('✅ PostgreSQL connected');
};
