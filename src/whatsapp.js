const axios = require('axios');
const FormData = require('form-data');

const AUTH_HEADER = { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };

function getApiUrl(phoneNumberId) {
  return `https://graph.facebook.com/v23.0/${phoneNumberId}/messages`;
}

function getMediaUrl(phoneNumberId) {
  return `https://graph.facebook.com/v23.0/${phoneNumberId}/media`;
}

function extensionFromContentType(contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  return 'jpg';
}

async function uploadImageFromUrl(phoneNumberId, imageUrl) {
  const link = encodeURI(String(imageUrl || '').trim());
  const imageRes = await axios.get(link, { responseType: 'arraybuffer', timeout: 20000 });
  const contentType = (imageRes.headers['content-type'] || 'image/jpeg').split(';')[0];
  const ext = extensionFromContentType(contentType);

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', Buffer.from(imageRes.data), {
    filename: `generated-greeting.${ext}`,
    contentType,
  });

  const uploadRes = await axios.post(getMediaUrl(phoneNumberId), form, {
    headers: { ...AUTH_HEADER, ...form.getHeaders() },
  });

  return uploadRes.data?.id;
}

async function sendRequest(phoneNumberId, body) {
  try {
    const res = await axios.post(getApiUrl(phoneNumberId), body, { headers: AUTH_HEADER });
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    console.error(`[whatsapp] API error status=${status} type=${body.interactive?.type || body.type}`);
    console.error('[whatsapp] API error body:', JSON.stringify(data));
    throw err;
  }
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
async function sendTyping(phoneNumberId, messageId) {
  if (!messageId) return;
  try {
    await axios.post(
      getApiUrl(phoneNumberId),
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' },
      },
      { headers: AUTH_HEADER }
    );
  } catch (e) {
    // בחלק מהחשבונות typing_indicator עדיין לא נתמך
    console.warn('sendTyping failed:', e.response?.data?.error?.message || e.message);
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
 * שלח תמונה באמצעות URL
 */
function sendImage(phoneNumberId, to, imageUrl, caption = '') {
  const link = encodeURI(String(imageUrl || '').trim());
  return sendRequest(phoneNumberId, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'image',
    image: {
      link,
      ...(caption ? { caption } : {}),
    },
  }).catch(async (err) => {
    const code = err.response?.data?.error?.code;
    if (code !== 131053) throw err;

    // If Meta cannot fetch image URL directly, upload bytes first and send by media id.
    const mediaId = await uploadImageFromUrl(phoneNumberId, imageUrl);
    if (!mediaId) throw err;

    return sendRequest(phoneNumberId, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'image',
      image: {
        id: mediaId,
        ...(caption ? { caption } : {}),
      },
    });
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
  const cards = greetings
    .slice(0, 10)
    .map((g, index) => {
      const imageLink = String(g.image || g.image_url || g.thumbnail || '').trim();
      if (!/^https?:\/\//i.test(imageLink)) return null;
      const encodedImageLink = encodeURI(imageLink);

      return {
        card_index: index,
        type: 'cta_url',
        header: {
          type: 'image',
          image: { link: encodedImageLink },
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
      };
    })
    .filter(Boolean);

  if (cards.length === 0) {
    throw new Error('No valid image cards for carousel');
  }

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
          flow_message_version: '3',
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

/**
 * fallback: רשימת ברכות כ-Interactive List (כאשר carousel נכשל)
 * greetings: [{ id, image, title }]
 */
function sendGreetingList(phoneNumberId, to, categoryTitle, greetings) {
  const rows = greetings.slice(0, 10).map((g, index) => ({
    id: `choose_greeting_${g.id}`,
    title: (g.title || g.name || `ברכה ${index + 1}`).slice(0, 24),
  }));

  return sendRequest(phoneNumberId, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: categoryTitle },
      body: { text: 'בחר את העיצוב המועדף:' },
      footer: { text: 'GraphoLike' },
      action: {
        button: 'בחר עיצוב',
        sections: [{ title: 'עיצובים', rows }],
      },
    },
  });
}

module.exports = { sendText, sendImage, sendCategoryList, sendGreetingCarousel, sendGreetingList, markAsRead, sendTyping, sendFlowMessage };
