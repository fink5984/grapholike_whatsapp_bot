// ניהול תשלומים ממתינים (שלבים 8–10) — נדרים פלוס.
//
// TODO(persistence): כרגע הכל בזיכרון בלבד — נמחק עם הפעלה מחדש של השרת.
// לקוח שקיבל קישור תשלום לפני ריסטארט יראה "הקישור אינו תקף". יש להעביר
// ל-DB/Redis יחד עם profiles.js.

const crypto = require('crypto');

const payments = new Map(); // token -> payment

// כמה זמן קישור תשלום נשאר בתוקף
const PAYMENT_LINK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * יוצר רשומת תשלום ממתינה ומחזיר אותה (כולל token ייחודי לקישור).
 * fields — פרטי האירוע שמולאו בטופס, נשמרים כדי להפעיל את יצירת העיצוב
 * רק אחרי אישור התשלום.
 */
function createPayment({ phone, phoneNumberId, greetingId, fields, amount, image, customer }) {
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
  payments.set(token, payment);
  return payment;
}

function getPayment(token) {
  return payments.get(token) || null;
}

function isExpired(payment) {
  return Date.now() - payment.createdAt > PAYMENT_LINK_TTL_MS;
}

/**
 * מסמן תשלום כשולם. אידמפוטנטי — מחזיר את התשלום רק בפעם הראשונה.
 * האישור יכול להגיע פעמיים (מהדף בצד לקוח וגם מה-CallBack של נדרים לשרת),
 * וההחזרה החד-פעמית מבטיחה שהעיצוב ייווצר ויישלח פעם אחת בלבד.
 */
function markPaid(token, transaction) {
  const payment = payments.get(token);
  if (!payment || payment.status === 'paid') return null;
  payment.status = 'paid';
  payment.paidAt = Date.now();
  payment.transaction = transaction || null;
  return payment;
}

module.exports = { createPayment, getPayment, markPaid, isExpired };
