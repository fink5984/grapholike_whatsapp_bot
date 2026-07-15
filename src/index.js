require('dotenv').config();
const express = require('express');
const { handleMessage, handlePaymentConfirmed } = require('./handler');
const { createPayment, getPayment, isExpired } = require('./payments');
const { renderPaymentPage, renderStatusPage } = require('./paymentPage');
const { getCategories } = require('./catalog');

const app = express();
app.use(express.json());
// ה-CallBack של נדרים פלוס מגיע כ-form-urlencoded
app.use(express.urlencoded({ extended: true }));

const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const PORT = process.env.PORT || 3000;

// ────────────────────────────────────────────────────────────
// GET /webhook  —  אימות Webhook ע"י Meta
// ────────────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified by Meta');
    return res.status(200).send(challenge);
  }

  console.warn('Webhook verification failed');
  return res.sendStatus(403);
});

// ────────────────────────────────────────────────────────────
// POST /webhook  —  קבלת הודעות נכנסות מ-WhatsApp
// ────────────────────────────────────────────────────────────
app.post('/webhook', (req, res) => {
  // Meta מצפה ל-200 מיידי
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;
    const statuses = value?.statuses;
    const contacts = value?.contacts;
    const phoneNumberId = value?.metadata?.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID;

    // Meta שולחת phone_number_id=123456123 בהודעות בדיקה מה-dashboard — מתעלמים מהן
    if (!phoneNumberId || phoneNumberId === '123456123') return;

    if (statuses && statuses.length > 0) {
      for (const s of statuses) {
        const statusErrors = (s.errors || [])
          .map((e) => `${e.code || 'unknown'}:${e.title || e.message || 'unknown error'}`)
          .join(' | ');
        console.log(
          `[STATUS] id=${s.id} status=${s.status} to=${s.recipient_id || 'unknown'} pricing=${s.pricing?.category || 'n/a'}`
        );
        if (statusErrors) {
          console.warn(`[STATUS] errors=${statusErrors}`);
        }
      }
    }

    if (!messages || messages.length === 0) return;

    const message = messages[0];
    const contact = contacts?.[0];

    // לוג של כל הודעה נכנסת
    console.log(`[IN] from=${message.from} type=${message.type} id=${message.id}`);
    if (message.type === 'text') {
      console.log(`[IN] text="${message.text?.body}"`);
    } else if (message.type === 'interactive') {
      const iType = message.interactive?.type;
      const reply = message.interactive?.[iType];
      console.log(`[IN] interactive type=${iType} id=${reply?.id} title=${reply?.title}`);
    } else if (message.type === 'button') {
      console.log(`[IN] button payload="${message.button?.payload}" text="${message.button?.text}"`);
    }

    handleMessage(message, contact, phoneNumberId).catch((err) => {
      console.error('Error handling message:', err.message);
      if (err.response) {
        console.error('API status:', err.response.status);
        console.error('API response:', JSON.stringify(err.response.data));
      }
    });
  } catch (err) {
    console.error('Error parsing webhook:', err.message);
  }
});

// ────────────────────────────────────────────────────────────
// GET /debug/catalog — אבחון גישה לקטלוג מהשרת עצמו (Railway).
// מוגן בטוקן האימות של ה-webhook: /debug/catalog?token=<WEBHOOK_VERIFY_TOKEN>
// ────────────────────────────────────────────────────────────
app.get('/debug/catalog', async (req, res) => {
  if (req.query.token !== VERIFY_TOKEN) return res.sendStatus(403);
  try {
    const categories = await getCategories();
    res.json({ ok: true, count: categories.length, categories });
  } catch (err) {
    const raw = err.response?.data;
    res.status(500).json({
      ok: false,
      status: err.response?.status || null,
      code: err.code || null,
      message: err.message,
      body: (typeof raw === 'string' ? raw.slice(0, 500) : raw) || null,
    });
  }
});

// ────────────────────────────────────────────────────────────
// GET /debug/test-payment — יצירת קישור תשלום לדוגמה לבדיקות דף התשלום,
// בלי לעבור את כל זרימת הבוט. מוגן בטוקן האימות של ה-webhook.
// /debug/test-payment?token=<WEBHOOK_VERIFY_TOKEN>
// ────────────────────────────────────────────────────────────
app.get('/debug/test-payment', async (req, res) => {
  if (req.query.token !== VERIFY_TOKEN) return res.sendStatus(403);
  const payment = await createPayment({
    phone: '972523413357',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    greetingId: 384483,
    fields: { name: 'בדיקה', parsha: 'בדיקה' },
    amount: '5',
    image: '',
    customer: { name: 'דוד פינק', email: 'fink5984@gmail.com', phone: '972523413357' },
  });
  const baseUrl = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  res.json({ ok: true, link: `${baseUrl}/pay/${payment.token}` });
});

// ────────────────────────────────────────────────────────────
// שלב 9 — GET /pay/:token — דף התשלום (אייפרם נדרים פלוס)
// ────────────────────────────────────────────────────────────
app.get('/pay/:token', async (req, res) => {
  const payment = await getPayment(req.params.token);

  if (!payment) {
    return res.status(404).send(renderStatusPage({
      icon: '🔍',
      title: 'הקישור אינו תקף',
      body: 'קישור התשלום לא נמצא. חזרו לוואטסאפ והתחילו הזמנה חדשה, ונשמח לעזור.',
    }));
  }

  if (payment.status === 'paid') {
    return res.send(renderStatusPage({
      icon: '🎉',
      title: 'התשלום כבר בוצע',
      body: 'ההזמנה שלכם שולמה ונמצאת בטיפול. העיצוב יישלח אליכם בוואטסאפ ובמייל.',
    }));
  }

  if (isExpired(payment)) {
    return res.status(410).send(renderStatusPage({
      icon: '⏰',
      title: 'הקישור פג תוקף',
      body: 'קישור התשלום היה בתוקף ל-24 שעות. חזרו לוואטסאפ ומלאו את הפרטים מחדש.',
    }));
  }

  const baseUrl = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  res.send(renderPaymentPage({
    payment,
    mosadId: process.env.NEDARIM_MOSAD_ID,
    apiValid: process.env.NEDARIM_API_VALID,
    callbackUrl: `${baseUrl}/nedarim-callback`,
    confirmUrl: `${baseUrl}/pay/${payment.token}/confirm`,
  }));
});

// ────────────────────────────────────────────────────────────
// שלב 10 — POST /pay/:token/confirm — אישור תשלום מדף התשלום (צד לקוח)
// ────────────────────────────────────────────────────────────
app.post('/pay/:token/confirm', (req, res) => {
  res.sendStatus(200);
  const transaction = req.body?.transaction;
  // הדף שולח אישור רק על הצלחה, אבל ליתר ביטחון — עסקה עם Status=Error
  // לעולם לא מאשרת תשלום.
  if (!transaction || String(transaction.Status || '').toLowerCase() === 'error') {
    console.warn(`[pay] client confirm rejected token=${req.params.token} status=${transaction?.Status}`);
    return;
  }
  handlePaymentConfirmed(req.params.token, transaction, 'client').catch((err) => {
    console.error('Error handling client payment confirm:', err.message);
  });
});

// ────────────────────────────────────────────────────────────
// שלב 10 — POST /nedarim-callback — CallBack שרת-לשרת מנדרים פלוס.
// גיבוי לאישור צד הלקוח: מבטיח שהעסקה לא תאבד גם אם הלקוח סגר את הדף
// לפני שהאישור נשלח. הטוקן שלנו נשלח לנדרים כ-Param1.
// ────────────────────────────────────────────────────────────
app.post('/nedarim-callback', (req, res) => {
  res.sendStatus(200);
  const data = { ...req.query, ...req.body };
  console.log('[nedarim] callback received:', JSON.stringify(data));

  const token = data.Param1 || data.param1;
  if (!token) {
    console.warn('[nedarim] callback without Param1 token — ignoring');
    return;
  }

  // נדרים שולחים CallBack גם על עסקאות שנדחו (Status=Error) — אסור לאשר
  // אותן. רק סטטוס שאינו Error נחשב תשלום מוצלח, וה-token נשאר פנוי
  // לניסיון תשלום חוזר מאותו דף.
  const status = String(data.Status || data.status || '').toLowerCase();
  if (status === 'error') {
    console.warn(`[nedarim] transaction DECLINED token=${token} message=${data.Message || ''}`);
    return;
  }

  handlePaymentConfirmed(String(token), data, 'nedarim-callback').catch((err) => {
    console.error('Error handling nedarim callback:', err.message);
  });
});

app.listen(PORT, () => {
  console.log(`WhatsApp bot running on port ${PORT}`);
  console.log(`Webhook URL: http://YOUR-DOMAIN/webhook`);
});
