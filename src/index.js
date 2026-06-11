require('dotenv').config();
const express = require('express');
const { handleMessage } = require('./handler');

const app = express();
app.use(express.json());

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
    const contacts = value?.contacts;
    const phoneNumberId = value?.metadata?.phone_number_id;

    if (!messages || messages.length === 0) return;

    const message = messages[0];
    const contact = contacts?.[0];

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

app.listen(PORT, () => {
  console.log(`WhatsApp bot running on port ${PORT}`);
  console.log(`Webhook URL: http://YOUR-DOMAIN/webhook`);
});
