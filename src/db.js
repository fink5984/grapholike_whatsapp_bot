// חיבור PostgreSQL אופציונלי (Supabase/Railway) דרך DATABASE_URL.
// כשאין DATABASE_URL — או שהחיבור נכשל — המודולים (profiles/payments/flows)
// נופלים לאחסון בזיכרון, כמו קודם. כך פיתוח מקומי ממשיך לעבוד בלי DB.

const { Pool } = require('pg');

const connectionString = String(process.env.DATABASE_URL || '').trim();

let pool = null;
if (connectionString) {
  pool = new Pool({
    connectionString,
    // ספקי ענן (Supabase וכד') מחייבים SSL אך מגישים אישור שלא עובר אימות CA
    ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
    max: 5,
  });
  pool.on('error', (err) => console.error('[db] pool error:', err.message));
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  phone      TEXT PRIMARY KEY,
  name       TEXT,
  email      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS last_orders (
  phone      TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS orders_history (
  id          BIGSERIAL PRIMARY KEY,
  phone       TEXT NOT NULL,
  order_id    TEXT,
  greeting_id TEXT,
  fields      JSONB,
  correction  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payments (
  token      TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at    TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS flows (
  key        TEXT PRIMARY KEY,
  flow_id    TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let readyPromise = null;
let dbAvailable = false;

/**
 * מחזיר true אם ה-DB מחובר והסכמה קיימת. false — עובדים מהזיכרון.
 * הבדיקה רצה פעם אחת; כשל הופך את כל המערכת למצב זיכרון (עם לוג ברור).
 */
function ready() {
  if (!pool) return Promise.resolve(false);
  if (!readyPromise) {
    readyPromise = pool
      .query(SCHEMA)
      .then(() => {
        dbAvailable = true;
        console.log('[db] connected — persistent storage enabled');
        return true;
      })
      .catch((err) => {
        console.error('[db] init failed — falling back to in-memory storage:', err.message);
        return false;
      });
  }
  return readyPromise;
}

function query(text, params) {
  if (!pool) throw new Error('DB not configured');
  return pool.query(text, params);
}

module.exports = { ready, query, isAvailable: () => dbAvailable };
