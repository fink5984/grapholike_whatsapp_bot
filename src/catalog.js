const axios = require('axios');

const BASE_URL = process.env.CATALOG_BASE_URL;
const API_KEY = process.env.CATALOG_API_KEY;

const headers = { 'X-ECARD-API-KEY': API_KEY };

/**
 * שליפת כל הקטגוריות מהקטלוג
 * מחזיר: [{ id, name }]
 */
async function getCategories() {
  const { data } = await axios.get(`${BASE_URL}/catalog`, { headers });

  // תמיכה בפורמטים שונים של תשובת ה-API
  if (data.categories && Array.isArray(data.categories)) {
    return data.categories.map((c) => ({ id: c.id, name: c.name || c.title }));
  }

  if (Array.isArray(data)) {
    // מערך ישיר של קטגוריות
    if (data[0] && (data[0].term_id || data[0].slug !== undefined)) {
      return data.map((c) => ({ id: c.term_id || c.id, name: c.name }));
    }
    // מערך של פריטים - מחלץ קטגוריות ייחודיות
    const catMap = new Map();
    data.forEach((item) => {
      const id = item.category_id || item.cat_id;
      const name = item.category_name || item.cat_name || item.category;
      if (id && name && !catMap.has(String(id))) catMap.set(String(id), name);
    });
    return Array.from(catMap.entries()).map(([id, name]) => ({ id, name }));
  }

  if (data.data && Array.isArray(data.data)) {
    return data.data.map((c) => ({ id: c.id, name: c.name || c.title }));
  }

  throw new Error('פורמט תגובת הקטלוג לא מזוהה');
}

/**
 * שליפת ברכות לפי קטגוריה
 * מחזיר: [{ id, image, title }]
 */
async function getGreetingsByCategory(categoryId) {
  const { data } = await axios.get(`${BASE_URL}/catalog`, {
    headers,
    params: { category_id: categoryId },
  });

  let greetings = [];

  if (data.greetings && Array.isArray(data.greetings)) {
    greetings = data.greetings;
  } else if (data.items && Array.isArray(data.items)) {
    greetings = data.items;
  } else if (data.data && Array.isArray(data.data)) {
    greetings = data.data;
  } else if (Array.isArray(data)) {
    greetings = data;
  }

  return greetings.map((g) => ({
    id: g.id,
    image: g.image || g.image_url || g.thumbnail || g.featured_image || '',
    title: g.title || g.name || '',
  }));
}

module.exports = { getCategories, getGreetingsByCategory };
