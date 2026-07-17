// src/services/emailService.js
const logger = require('../utils/logger');

// Sends email via nodemailer (SMTP). Falls back to console log if not configured.
exports.sendEmail = async ({ to, subject, html, text }) => {
  // If SMTP not configured, log and return (dev mode)
  if (!process.env.SMTP_HOST) {
    logger.info(`[EMAIL STUB] To: ${to} | Subject: ${subject}`);
    logger.debug('[EMAIL STUB] Body:', text || html);
    return { messageId: 'stub-' + Date.now() };
  }

  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: +(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_PORT === '465',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || `SmartReview <${process.env.SMTP_USER}>`,
      to, subject, html, text,
    });

    logger.info(`Email sent to ${to}: ${info.messageId}`);
    return info;
  } catch (err) {
    logger.error('Email send failed:', err.message);
    throw err;
  }
};
