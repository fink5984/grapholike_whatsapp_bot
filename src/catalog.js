const axios = require('axios');

const BASE_URL = process.env.CATALOG_BASE_URL;
const API_KEY = process.env.CATALOG_API_KEY;

const headers = { 'X-ECARD-API-KEY': API_KEY };

/**
 * שליפת כל הקטגוריות מהקטלוג
 * התשובה: [{name, greetings:[{id, image, content}]}]
 * מחזיר: [{ id, name }]  (id = אינדקס במערך)
 */
async function getCategories() {
  const { data } = await axios.get(`${BASE_URL}/catalog`, { headers });
  const arr = Array.isArray(data) ? data : Object.values(data);
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
  const { data } = await axios.get(`${BASE_URL}/catalog`, { headers });
  const arr = Array.isArray(data) ? data : Object.values(data);
  const category = arr[parseInt(categoryId, 10)];
  if (!category) return [];
  return (category.greetings || []).map((g) => ({
    id: g.id,
    image: g.image || '',
    title: category.name || '',
  }));
}

/**
 * שליפת ברכה בודדת לפי ID (כולל שדות התוכן שלה)
 * מחזיר: { id, image, content: [{name, param}] } או null
 */
async function getGreetingById(greetingId) {
  const { data } = await axios.get(`${BASE_URL}/catalog`, { headers });
  const arr = Array.isArray(data) ? data : Object.values(data);
  for (const category of arr) {
    const greeting = (category.greetings || []).find(
      (g) => String(g.id) === String(greetingId)
    );
    if (greeting) return greeting;
  }
  return null;
}

module.exports = { getCategories, getGreetingsByCategory, getGreetingById };
