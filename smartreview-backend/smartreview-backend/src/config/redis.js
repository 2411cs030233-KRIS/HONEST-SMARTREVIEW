// src/config/redis.js
const logger = require('../utils/logger');

let redisClient = null;

exports.connectRedis = async () => {
  try {
    const redis = require('redis');
    redisClient = redis.createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    redisClient.on('error', (err) => logger.warn('Redis error (non-fatal):', err.message));
    await redisClient.connect();
    exports.redisClient = redisClient;
    logger.info('✅ Redis connected');
  } catch (err) {
    // Redis is optional — app works without it (just no caching)
    logger.warn('⚠️  Redis unavailable, continuing without cache:', err.message);
  }
};

exports.redisClient = null; // will be set after connectRedis()
