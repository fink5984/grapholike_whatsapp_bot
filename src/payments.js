// ניהול תשלומים ממתינים (שלבים 8–10) — נדרים פלוס.
// נשמר ב-PostgreSQL כשמוגדר DATABASE_URL — קישור תשלום שורד פריסות/ריסטארט;
// אחרת בזיכרון (פיתוח מקומי). כל הפונקציות אסינכרוניות מלבד isExpired.

const crypto = require('crypto');
const db = require('./db');

const memPayments = new Map(); // token -> payment

// כמה זמן קישור תשלום נשאר בתוקף
const PAYMENT_LINK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * יוצר רשומת תשלום ממתינה ומחזיר אותה (כולל token ייחודי לקישור).
 * fields — פרטי האירוע שמולאו בטופס, נשמרים כדי להפעיל את יצירת העיצוב
 * רק אחרי אישור התשלום.
 */
async function createPayment({ phone, phoneNumberId, greetingId, fields, amount, image, customer }) {
  const token = crypto.randomBytes(16).toString('hex');
  const payment = {
    token,
    phone,
    phoneNumberId,
    greetingId,
    fields,
    amount: String(amount),
    image: image || '',
    customer: customer || {},
    status: 'pending', // pending | paid
    createdAt: Date.now(),
    paidAt: null,
    transaction: null,
  };

  if (await db.ready()) {
    await db.query(
      `INSERT INTO payments (token, data, status) VALUES ($1, $2::jsonb, 'pending')`,
      [token, JSON.stringify(payment)]
    );
    return payment;
  }

  memPayments.set(token, payment);
  return payment;
}

async function getPayment(token) {
  if (await db.ready()) {
    const { rows } = await db.query('SELECT data FROM payments WHERE token = $1', [token]);
    return rows[0] ? rows[0].data : null;
  }
  return memPayments.get(token) || null;
}

function isExpired(payment) {
  return Date.now() - payment.createdAt > PAYMENT_LINK_TTL_MS;
}

/**
 * מסמן תשלום כשולם. אידמפוטנטי — מחזיר את התשלום רק בפעם הראשונה.
 * האישור יכול להגיע פעמיים (מהדף בצד לקוח וגם מה-CallBack של נדרים לשרת),
 * וההחזרה החד-פעמית מבטיחה שהעיצוב ייווצר ויישלח פעם אחת בלבד.
 * ב-DB זה נאכף אטומית ברמת השאילתה (WHERE status='pending').
 */
async function markPaid(token, transaction) {
  const paidAt = Date.now();

  if (await db.ready()) {
    const { rows } = await db.query(
      `UPDATE payments
       SET status = 'paid',
           paid_at = now(),
           data = data || $2::jsonb
       WHERE token = $1 AND status = 'pending'
       RETURNING data`,
      [token, JSON.stringify({ status: 'paid', paidAt, transaction: transaction || null })]
    );
    return rows[0] ? rows[0].data : null;
  }

  const payment = memPayments.get(token);
  if (!payment || payment.status === 'paid') return null;
  payment.status = 'paid';
  payment.paidAt = paidAt;
  payment.transaction = transaction || null;
  return payment;
}

module.exports = { createPayment, getPayment, markPaid, isExpired };
