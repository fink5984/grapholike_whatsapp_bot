const axios = require('axios');

const AUTH_HEADER = { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };

function getApiUrl(phoneNumberId) {
  return `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`;
}

async function sendRequest(phoneNumberId, body) {
  const res = await axios.post(getApiUrl(phoneNumberId), body, { headers: AUTH_HEADER });
  return res.data;
}

/**
 * סמן הודעה כנקראה (וי כחול)
 */
async function markAsRead(phoneNumberId, messageId) {
  try {
    await axios.post(
      getApiUrl(phoneNumberId),
      { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
      { headers: AUTH_HEADER }
    );
  } catch (e) {
    console.warn('markAsRead failed:', e.message);
  }
}

/**
 * הצג אינדיקטור הקלדה
 */
async function sendTyping(phoneNumberId, to) {
  try {
    await axios.post(
      getApiUrl(phoneNumberId),
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'reaction',
        reaction: { message_id: 'typing', emoji: '' },
      },
      { headers: AUTH_HEADER }
    );
  } catch (_) {
    // typing indicator לא תמיד נתמך — מתעלמים משגיאה
  }
}

/**
 * שלח הודעת טקסט פשוטה
 */
function sendText(phoneNumberId, to, text) {
  return sendRequest(phoneNumberId, {
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
function sendCategoryList(phoneNumberId, to, name, categories) {
  const rows = categories.slice(0, 10).map((cat) => ({
    id: `cat_${cat.id}`,
    title: String(cat.name || cat.id).slice(0, 24),
  }));

  return sendRequest(phoneNumberId, {
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
function sendGreetingCarousel(phoneNumberId, to, categoryTitle, greetings) {
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

  return sendRequest(phoneNumberId, {
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

/**
 * שלח הודעת WhatsApp Flow
 * flowId — מזהה ה-Flow שנוצר דרך ה-API
 * bodyText — הטקסט שיוצג מעל הכפתור
 */
function sendFlowMessage(phoneNumberId, to, flowId, bodyText) {
  return sendRequest(phoneNumberId, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'flow',
      header: { type: 'text', text: 'ברכות גרפיות' },
      body: { text: bodyText },
      footer: { text: 'GraphoLike' },
      action: {
        name: 'flow',
        parameters: {
          flow_id: flowId,
          flow_cta: 'מלא פרטים',
          mode: 'published',
          flow_action: 'navigate',
          flow_action_payload: { screen: 'GREETING_FORM' },
        },
      },
    },
  });
}

module.exports = { sendText, sendCategoryList, sendGreetingCarousel, markAsRead, sendTyping, sendFlowMessage };
