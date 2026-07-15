// פרופיל הלקוח (שם + מייל), ההזמנה האחרונה שלו (לחלון התיקונים) והיסטוריית
// הזמנות. נשמר ב-PostgreSQL כשמוגדר DATABASE_URL; אחרת בזיכרון (פיתוח מקומי).
// כל הפונקציות אסינכרוניות — יש לקרוא להן עם await.

const db = require('./db');

const memProfiles = new Map(); // phone -> { name, email }
const memOrders = new Map(); // phone -> { greetingId, fields, orderId, createdAt, editing }

async function getProfile(phone) {
  if (await db.ready()) {
    const { rows } = await db.query('SELECT name, email FROM customers WHERE phone = $1', [phone]);
    return rows[0] || undefined;
  }
  return memProfiles.get(phone);
}

async function setProfile(phone, data) {
  if (await db.ready()) {
    const { rows } = await db.query(
      `INSERT INTO customers (phone, name, email) VALUES ($1, $2, $3)
       ON CONFLICT (phone) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, customers.name),
         email = COALESCE(EXCLUDED.email, customers.email),
         updated_at = now()
       RETURNING name, email`,
      [phone, data.name ?? null, data.email ?? null]
    );
    return rows[0];
  }
  const existing = memProfiles.get(phone) || {};
  memProfiles.set(phone, { ...existing, ...data });
  return memProfiles.get(phone);
}

async function getLastOrder(phone) {
  if (await db.ready()) {
    const { rows } = await db.query('SELECT data FROM last_orders WHERE phone = $1', [phone]);
    return rows[0] ? rows[0].data : undefined;
  }
  return memOrders.get(phone);
}

/** מיזוג עם הרשומה הקיימת — אותה סמנטיקה כמו במצב זיכרון. */
async function setLastOrder(phone, data) {
  if (await db.ready()) {
    const { rows } = await db.query(
      `INSERT INTO last_orders (phone, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (phone) DO UPDATE SET
         data = last_orders.data || EXCLUDED.data,
         updated_at = now()
       RETURNING data`,
      [phone, JSON.stringify(data)]
    );
    return rows[0].data;
  }
  const existing = memOrders.get(phone) || {};
  memOrders.set(phone, { ...existing, ...data });
  return memOrders.get(phone);
}

/** רישום היסטוריית הזמנות — שורה לכל יצירה/תיקון שהושלמו (DB בלבד). */
async function recordOrder(phone, { orderId, greetingId, fields, correction = false } = {}) {
  if (!(await db.ready())) return;
  try {
    await db.query(
      `INSERT INTO orders_history (phone, order_id, greeting_id, fields, correction)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [phone, orderId != null ? String(orderId) : null, greetingId != null ? String(greetingId) : null, JSON.stringify(fields || {}), !!correction]
    );
  } catch (err) {
    console.warn('[profiles] recordOrder failed:', err.message);
  }
}

module.exports = { getProfile, setProfile, getLastOrder, setLastOrder, recordOrder };
