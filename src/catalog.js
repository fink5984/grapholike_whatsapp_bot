const axios = require('axios');

const BASE_URL = process.env.CATALOG_BASE_URL;
const API_KEY = process.env.CATALOG_API_KEY;

const headers = {
  'X-ECARD-API-KEY': API_KEY,
  // חומות אש של וורדפרס/Cloudflare חוסמות לעיתים User-Agent של ספריות
  // (axios/1.x) — במיוחד בבקשות שמגיעות מ-IP של דטה-סנטר כמו Railway.
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 GrapholikeBot/1.0',
  Accept: 'application/json',
};

// הקטלוג נקרא בכל שלב בשיחה — קאש קצר חוסך קריאות כפולות ומקטין את הסיכוי
// להיחסם על ידי rate-limit בצד האתר.
const CATALOG_CACHE_TTL_MS = 60 * 1000;
let catalogCache = { data: null, fetchedAt: 0 };

/**
 * שליפת הקטלוג המלא (עם קאש קצר).
 * בכשל — לוג מפורט (סטטוס + תחילת גוף התשובה) כדי שאפשר יהיה לאבחן
 * חסימות WAF/Cloudflare מהלוגים של השרת, ואז זריקת השגיאה הלאה.
 */
async function fetchCatalog() {
  const now = Date.now();
  if (catalogCache.data && now - catalogCache.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return catalogCache.data;
  }

  try {
    const { data } = await axios.get(`${BASE_URL}/catalog`, { headers, timeout: 20000 });
    const arr = Array.isArray(data) ? data : Object.values(data || {});
    catalogCache = { data: arr, fetchedAt: now };
    return arr;
  } catch (err) {
    const status = err.response?.status || err.code || 'n/a';
    const raw = err.response?.data;
    const bodySnippet = (typeof raw === 'string' ? raw : JSON.stringify(raw || '')).slice(0, 300);
    console.error(`[catalog] fetch FAILED status=${status} body=${bodySnippet}`);
    // אם יש קאש ישן — עדיף להגיש אותו מאשר להפיל את השיחה
    if (catalogCache.data) {
      console.warn('[catalog] serving stale cache after fetch failure');
      return catalogCache.data;
    }
    throw err;
  }
}

/**
 * שליפת כל הקטגוריות מהקטלוג
 * התשובה: [{name, greetings:[{id, image, price, content}]}]
 * מחזיר: [{ id, name }]  (id = אינדקס במערך)
 */
async function getCategories() {
  const arr = await fetchCatalog();
  return arr.map((item, index) => ({
    id: String(index),
    name: item.name || `קטגוריה ${index + 1}`,
  }));
}

/**
 * שליפת ברכות לפי אינדקס קטגוריה
 * מחזיר: [{ id, image, title }]
 */
async function getGreetingsByCategory(categoryId) {
  const arr = await fetchCatalog();
  const category = arr[parseInt(categoryId, 10)];
  if (!category) return [];
  return (category.greetings || []).map((g) => ({
    id: g.id,
    image: g.image || '',
    title: category.name || '',
  }));
}

/**
 * שליפת ברכה בודדת לפי ID (כולל שדות התוכן והמחיר שלה)
 * מחזיר: { id, image, price, content: [{name, param}] } או null
 */
async function getGreetingById(greetingId) {
  const arr = await fetchCatalog();
  for (const category of arr) {
    const greeting = (category.greetings || []).find(
      (g) => String(g.id) === String(greetingId)
    );
    if (greeting) return greeting;
  }
  return null;
}

module.exports = { getCategories, getGreetingsByCategory, getGreetingById };
