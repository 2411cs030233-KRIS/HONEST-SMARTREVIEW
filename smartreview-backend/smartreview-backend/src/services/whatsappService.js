// ============================================================
//  src/services/whatsappService.js  — Twilio WhatsApp
// ============================================================
const twilio = require('twilio');
const { pool } = require('../config/db');
const logger   = require('../utils/logger');

// Lazy-init Twilio — only connects when env vars are present
let _client = null;
const getClient = () => {
  if (!_client) {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      throw new Error("Twilio credentials not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in .env");
    }
    _client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return _client;
};
const FROM   = `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`;

// ── Core send function ────────────────────────────────────────
exports.sendWhatsApp = async (to, body, restaurantId = null, customerId = null, type = 'bill') => {
  const phone = to.startsWith('+') ? to : `+91${to}`;
  try {
    const msg = await getClient().messages.create({
      from: FROM,
      to:   `whatsapp:${phone}`,
      body,
    });

    // Log to DB
    if (restaurantId) {
      await pool.query(`
        INSERT INTO whatsapp_messages (restaurant_id, customer_id, phone, message, type, status, twilio_sid, sent_at)
        VALUES ($1,$2,$3,$4,$5,'sent',$6,NOW())
      `, [restaurantId, customerId, phone, body, type, msg.sid]);
    }

    logger.info(`WhatsApp sent to ${phone} | SID: ${msg.sid}`);
    return msg;
  } catch (err) {
    logger.error(`WhatsApp failed to ${phone}:`, err.message);

    if (restaurantId) {
      await pool.query(`
        INSERT INTO whatsapp_messages (restaurant_id, customer_id, phone, message, type, status, error_message)
        VALUES ($1,$2,$3,$4,$5,'failed',$6)
      `, [restaurantId, customerId, phone, body, type, err.message]);
    }
    throw err;
  }
};

// ── Send bill to customer ─────────────────────────────────────
exports.sendBillMessage = async (bill, restaurantName, feedbackUrl) => {
  const items = (bill.items || [])
    .map(i => `  • ${i.emoji || ''} ${i.name} ×${i.quantity} — ₹${i.subtotal}`)
    .join('\n');

  const body = `🍴 *${restaurantName}*\n\nHi! Your bill is ready.\n\n${items}\n\n💰 Total: ₹${bill.total}\n\n⭐ Please rate your experience & pay here:\n${feedbackUrl}\n\n_(Leave a Google review to unlock a loyalty discount!)_`;

  return exports.sendWhatsApp(bill.customer_phone, body, bill.restaurant_id, bill.customer_id, 'bill');
};

// ── Send discount offer (campaign) ───────────────────────────
exports.sendDiscountOffer = async (customer, restaurantName, offerText, restaurantId) => {
  const body = `🎉 *${restaurantName}* misses you!\n\n${offerText}\n\nBook your table now and show this message. Limited time offer! 🙏`;
  return exports.sendWhatsApp(customer.phone, body, restaurantId, customer.id, 'campaign');
};

// ── Send automated daily report ───────────────────────────────
exports.sendDailyReport = async (phone, stats, restaurantName) => {
  const body = `📊 *${restaurantName} — Daily Report*\n📅 ${new Date().toLocaleDateString('en-IN', {weekday:'long', day:'numeric', month:'short'})}\n\n💰 Revenue: ₹${stats.total_revenue?.toLocaleString('en-IN') || 0}\n🧾 Bills: ${stats.total_bills || 0} (Avg ₹${Math.round(stats.avg_bill_value) || 0})\n⭐ Avg Rating: ${stats.avg_rating ? (+stats.avg_rating).toFixed(1) : 'N/A'}★\n🌟 Google Reviews: +${stats.google_reviews || 0}\n⚠️ Complaints: ${stats.negative_reviews || 0}\n💬 WhatsApp msgs: ${stats.wa_messages_sent || 0}\n\n_SmartReview — Growing your restaurant 🚀_`;

  return exports.sendWhatsApp(phone, body, null, null, 'report');
};

// ── Bulk campaign ─────────────────────────────────────────────
exports.sendCampaign = async (restaurantId, segment, template, offerText) => {
  let query = 'SELECT id, phone, name FROM customers WHERE restaurant_id=$1 AND whatsapp_opt_in=TRUE';
  const params = [restaurantId];

  if (segment === 'recent') {
    query += ' AND last_visit_at >= NOW() - INTERVAL \'7 days\'';
  } else if (segment === 'inactive') {
    query += ' AND last_visit_at < NOW() - INTERVAL \'30 days\'';
  } else if (segment === '5star') {
    query += ' AND avg_rating >= 4.5';
  }

  const { rows: customers } = await pool.query(query, params);
  const { rows: [restaurant] } = await pool.query('SELECT name FROM restaurants WHERE id=$1', [restaurantId]);

  let sent = 0, failed = 0;
  for (const customer of customers) {
    const personalised = template
      .replace('[Name]', customer.name || 'Guest')
      .replace('[DISC]', offerText);
    try {
      await exports.sendWhatsApp(customer.phone, personalised, restaurantId, customer.id, 'campaign');
      sent++;
      await new Promise(r => setTimeout(r, 100)); // rate limiting
    } catch {
      failed++;
    }
  }

  return { total: customers.length, sent, failed };
};

// ── Send payment receipt (called after Razorpay payment verified) ──────
exports.sendPaymentReceipt = async (bill, paymentData, restaurantData, discountPct = 0) => {
  if (!bill.customer_phone) return;

  const sub      = +bill.subtotal || +bill.total;
  const discAmt  = Math.round(sub * discountPct / 100);
  const taxable  = sub - discAmt;
  const cgst     = Math.round(taxable * 0.025);
  const sgst     = Math.round(taxable * 0.025);
  const total    = taxable + cgst + sgst;

  const items = (bill.items || [])
    .map(i => `  ${i.emoji||'•'} ${i.name}${i.qty>1?' ×'+i.qty:''} — ₹${Math.round(i.price*(i.qty||1))}`)
    .join('\n');

  const discLine = discountPct > 0
    ? `\n🎁 Google Review Discount (${discountPct}%): -₹${discAmt}`
    : '';

  const gstLine = restaurantData.gstin
    ? `\n📋 GSTIN: ${restaurantData.gstin}`
    : '';

  const txnLine = paymentData.payment_id
    ? `\n🔖 Txn Ref: ${paymentData.payment_id}`
    : '';

  const now     = new Date();
  const dateStr = now.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
  const timeStr = now.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' });

  const body =
`✅ *Payment Successful!*

🏪 *${restaurantData.name}*
${restaurantData.address ? restaurantData.address + '\n' : ''}${gstLine}

📋 Bill No: *${bill.bill_number}*
🪑 Table: ${bill.table_number || '—'}
📅 ${dateStr}  ${timeStr}

━━━━━━━━━━━━━━━━━━
${items}
━━━━━━━━━━━━━━━━━━
Subtotal:         ₹${sub}${discLine}
CGST (2.5%):      ₹${cgst}
SGST (2.5%):      ₹${sgst}
━━━━━━━━━━━━━━━━━━
*TOTAL PAID:      ₹${total}*
💳 Method: ${(paymentData.method||'UPI').toUpperCase()}${txnLine}

Thank you for dining with us! 🙏
We hope to see you again soon.
— ${restaurantData.owner_name||'Team'}, ${restaurantData.name}`;

  return exports.sendWhatsApp(
    bill.customer_phone, body,
    bill.restaurant_id, bill.customer_id, 'receipt'
  );
};

// ── Send complaint alert to owner ─────────────────────────────
exports.sendComplaintAlert = async (ownerPhone, bill, rating, complaints, restaurantName) => {
  if (!ownerPhone) return;

  const stars    = '★'.repeat(rating) + '☆'.repeat(5 - rating);
  const compList = complaints.length > 0
    ? complaints.map(c => `  ⚠️ ${c}`).join('\n')
    : '  • No specific category selected';

  const body =
`⚠️ *New Complaint Alert — ${restaurantName}*

${stars} ${rating}/5 star rating

📋 Bill: #${bill.bill_number}
🪑 Table: ${bill.table_number || '—'}
📱 Customer: ${bill.customer_phone || 'Unknown'}

*Issues reported:*
${compList}
${bill.comment ? `\n💬 Comment: "${bill.comment}"` : ''}

👉 Go to SmartReview dashboard to view and resolve this complaint.
Once resolved, a personal WhatsApp will be sent to the customer with a 3% return coupon.`;

  return exports.sendWhatsApp(ownerPhone, body, bill.restaurant_id, null, 'alert');
};
