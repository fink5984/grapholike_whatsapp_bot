const axios = require('axios');

const WA_API_URL = `https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
const AUTH_HEADER = { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };

async function sendRequest(body) {
  const res = await axios.post(WA_API_URL, body, { headers: AUTH_HEADER });
  return res.data;
}

/**
 * שלח הודעת טקסט פשוטה
 */
function sendText(to, text) {
  return sendRequest({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: text },
  });
}

/**
 * שלח תפריט בחירת קטגוריה (Interactive List)
 * categories: [{ id, name }]
 */
function sendCategoryList(to, name, categories) {
  const rows = categories.slice(0, 10).map((cat) => ({
    id: `cat_${cat.id}`,
    title: String(cat.name || cat.id).slice(0, 24),
  }));

  return sendRequest({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'ברכות גרפיות' },
      body: { text: `שלום ${name}!\nבחר את קטגוריית הברכה:` },
      footer: { text: 'GraphoLike' },
      action: {
        button: 'בחר קטגוריה',
        sections: [{ title: 'קטגוריות', rows }],
      },
    },
  });
}

/**
 * שלח קרוסלה של ברכות
 * greetings: [{ id, image, title }]
 */
function sendGreetingCarousel(to, categoryTitle, greetings) {
  const cards = greetings.slice(0, 10).map((g, index) => ({
    card_index: index,
    type: 'button',
    header: {
      type: 'image',
      image: { link: encodeURI(g.image || g.image_url || g.thumbnail || '') },
    },
    body: {
      text: (g.title || g.name || `ברכה ${index + 1}`).slice(0, 160),
    },
    action: {
      buttons: [
        {
          type: 'quick_reply',
          quick_reply: {
            id: `choose_greeting_${g.id}`,
            title: 'בחר',
          },
        },
      ],
    },
  }));

  return sendRequest({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'carousel',
      body: { text: `עיצובים לקטגוריה: ${categoryTitle}\nבחר את העיצוב המועדף:` },
      action: { cards },
    },
  });
}

module.exports = { sendText, sendCategoryList, sendGreetingCarousel };
