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

// WhatsApp rejects inline images larger than 5 MB (both upload and link send).
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

async function downloadImage(imageUrl) {
  const link = encodeURI(String(imageUrl || '').trim());

  // Wait briefly — the generated image file may not be fully written yet
  await new Promise((resolve) => setTimeout(resolve, 2000));

  let imageRes;
  try {
    imageRes = await axios.get(link, { responseType: 'arraybuffer', timeout: 30000 });
  } catch (downloadErr) {
    console.error('[whatsapp] Image download failed:', downloadErr.message, link);
    throw downloadErr;
  }
  const contentType = (imageRes.headers['content-type'] || 'image/jpeg').split(';')[0];
  return { buffer: Buffer.from(imageRes.data), contentType, link };
}

async function uploadImageBuffer(phoneNumberId, buffer, contentType) {
  const ext = extensionFromContentType(contentType);

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', buffer, {
    filename: `generated-greeting.${ext}`,
    contentType,
  });

  const uploadRes = await axios.post(getMediaUrl(phoneNumberId), form, {
    headers: { ...AUTH_HEADER, ...form.getHeaders() },
  }).catch((uploadErr) => {
    console.error('[whatsapp] Media upload 400 details:', JSON.stringify(uploadErr.response?.data));
    throw uploadErr;
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
 * שלח תמונה באמצעות URL.
 * תמונה עד 5MB נשלחת inline; תמונה גדולה יותר (או כשל בהעלאה) נשלחת כקישור לחיץ.
 */
async function sendImage(phoneNumberId, to, imageUrl, caption = '') {
  const link = encodeURI(String(imageUrl || '').trim());

  // Fallback used whenever inline image isn't possible — a clickable text link always delivers.
  const sendAsLink = () =>
    sendText(phoneNumberId, to, `${caption ? caption + '\n\n' : ''}${link}`);

  let file;
  try {
    file = await downloadImage(imageUrl);
  } catch (downloadErr) {
    console.warn('[whatsapp] download failed, sending link instead:', downloadErr.message);
    return sendAsLink();
  }

  if (file.buffer.length > IMAGE_MAX_BYTES) {
    console.log(
      `[whatsapp] image ${file.buffer.length} bytes exceeds ${IMAGE_MAX_BYTES} limit — sending link instead`
    );
    return sendAsLink();
  }

  try {
    const mediaId = await uploadImageBuffer(phoneNumberId, file.buffer, file.contentType);
    if (!mediaId) {
      throw new Error('Media upload returned empty id');
    }
    return await sendRequest(phoneNumberId, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'image',
      image: {
        id: mediaId,
        ...(caption ? { caption } : {}),
      },
    });
  } catch (uploadErr) {
    console.warn('[whatsapp] inline image send failed, sending link instead:', uploadErr.message);
    return sendAsLink();
  }
}

/**
 * שלח תפריט בחירת קטגוריה (Interactive List)
 * categories: [{ id, name }]
 */
function sendCategoryList(phoneNumberId, to, bodyText, categories) {
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
      header: { type: 'text', text: 'סוג השמחה' },
      body: { text: bodyText },
      footer: { text: 'GraphoLike' },
      action: {
        button: 'בחירת קטגוריה',
        sections: [{ title: 'קטגוריות', rows }],
      },
    },
  });
}

/**
 * שלח קרוסלה של ברכות
 * greetings: [{ id, image, title }]
 */
function sendGreetingCarousel(phoneNumberId, to, categoryTitle, greetings, bodyText) {
  const cards = greetings
    .slice(0, 10)
    .filter((g) => /^https?:\/\//i.test(String(g.image || g.image_url || g.thumbnail || '').trim()))
    .map((g, index) => {
      const imageLink = String(g.image || g.image_url || g.thumbnail || '').trim();
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
    });

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
      body: { text: bodyText || `עיצובים לקטגוריה: ${categoryTitle}\nבחר את העיצוב המועדף:` },
      action: { cards },
    },
  });
}

/**
 * שלח הודעת WhatsApp Flow
 * flowId — מזהה ה-Flow שנוצר דרך ה-API
 * opts:
 *   bodyText   — הטקסט שיוצג מעל הכפתור
 *   headerText — כותרת ההודעה
 *   cta        — תווית הכפתור
 *   screen     — מזהה המסך הראשון ב-Flow
 *   data       — ערכי prefill למסך (למשל פתיחה מחדש לתיקון)
 */
function sendFlowMessage(phoneNumberId, to, flowId, opts = {}) {
  const {
    bodyText = 'מלא את הפרטים',
    headerText = 'ברכות גרפיות',
    cta = 'מלא פרטים',
    screen = 'GREETING_FORM',
    data,
  } = opts;

  const flowActionPayload = { screen };
  if (data && Object.keys(data).length > 0) {
    flowActionPayload.data = data;
  }

  return sendRequest(phoneNumberId, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'flow',
      header: { type: 'text', text: headerText },
      body: { text: bodyText },
      footer: { text: 'GraphoLike' },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_id: flowId,
          flow_cta: cta,
          mode: 'published',
          flow_action: 'navigate',
          flow_action_payload: flowActionPayload,
        },
      },
    },
  });
}

/**
 * שלח הודעה עם כפתור שפותח קישור (CTA URL) — למשל כפתור "לתשלום מאובטח".
 * opts: { bodyText, buttonText, url, headerText?, footerText? }
 */
function sendCtaUrl(phoneNumberId, to, { bodyText, buttonText, url, headerText, footerText }) {
  return sendRequest(phoneNumberId, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      ...(headerText ? { header: { type: 'text', text: headerText } } : {}),
      body: { text: bodyText },
      ...(footerText ? { footer: { text: footerText } } : {}),
      action: {
        name: 'cta_url',
        parameters: {
          display_text: String(buttonText).slice(0, 20),
          url,
        },
      },
    },
  });
}

/**
 * שלח הודעה עם כפתורי reply (עד 3).
 * buttons: [{ id, title }]
 */
function sendButtons(phoneNumberId, to, bodyText, buttons) {
  return sendRequest(phoneNumberId, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: String(b.title).slice(0, 20) },
        })),
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

module.exports = { sendText, sendImage, sendCategoryList, sendGreetingCarousel, sendGreetingList, markAsRead, sendTyping, sendFlowMessage, sendButtons, sendCtaUrl };
