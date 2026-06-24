// פרופיל המשתמש (שם + מייל) וההזמנה האחרונה שלו.
//
// TODO(persistence): כרגע הכל בזיכרון בלבד — נמחק עם הפעלה מחדש של השרת.
// יש להעביר ל-DB/Redis כדי שהפרטים האישיים וחלון התיקונים (24 שעות, שלב 13)
// ישרדו ריסטארט. המבנה כאן מבודד את הקריאות כך שהמעבר יהיה נקודתי.

const profiles = new Map(); // phone -> { name, email }
const orders = new Map(); // phone -> { greetingId, fields, createdAt, editing }

function getProfile(phone) {
  return profiles.get(phone);
}

function setProfile(phone, data) {
  const existing = profiles.get(phone) || {};
  profiles.set(phone, { ...existing, ...data });
  return profiles.get(phone);
}

function getLastOrder(phone) {
  return orders.get(phone);
}

function setLastOrder(phone, data) {
  const existing = orders.get(phone) || {};
  orders.set(phone, { ...existing, ...data });
  return orders.get(phone);
}

module.exports = { getProfile, setProfile, getLastOrder, setLastOrder };
