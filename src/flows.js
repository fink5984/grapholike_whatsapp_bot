const axios = require('axios');
const FormData = require('form-data');

const flowCache = new Map(); // greetingId -> flowId

function buildFlowJson(greeting) {
  const formChildren = (greeting.content || []).map((field) => ({
    type: 'TextInput',
    label: field.name,
    name: field.param,
    'input-type': field.param === 'phone' ? 'phone' : 'text',
    required: true,
  }));

  formChildren.push({
    type: 'Footer',
    label: 'שלח ברכה',
    'on-click-action': {
      name: 'complete',
      payload: { greeting_id: String(greeting.id) },
    },
  });

  return {
    version: '6.0',
    screens: [
      {
        id: 'GREETING_FORM',
        title: 'פרטים לברכה',
        terminal: true,
        success: true,
        data: {},
        layout: {
          type: 'SingleColumnLayout',
          children: [
            {
              type: 'Form',
              name: 'greeting_form',
              children: formChildren,
            },
          ],
        },
      },
    ],
  };
}

async function getOrCreateFlow(greeting) {
  const WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!WABA_ID) {
    throw new Error('WHATSAPP_BUSINESS_ACCOUNT_ID env var is not set');
  }

  const cacheKey = String(greeting.id);
  if (flowCache.has(cacheKey)) {
    console.log(`[flows] Using cached flow for greeting ${greeting.id}`);
    return flowCache.get(cacheKey);
  }

  const authHeader = { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };

  console.log(`[flows] Creating flow for greeting ${greeting.id}`);

  // 1. Create flow
  const createRes = await axios.post(
    `https://graph.facebook.com/v22.0/${WABA_ID}/flows`,
    { name: `greeting_${greeting.id}`, categories: ['OTHER'] },
    { headers: authHeader }
  );
  const flowId = createRes.data.id;
  console.log(`[flows] Created flow id=${flowId}`);

  // 2. Upload flow JSON
  const flowJson = buildFlowJson(greeting);
  const form = new FormData();
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');
  form.append('file', Buffer.from(JSON.stringify(flowJson)), {
    filename: 'flow.json',
    contentType: 'application/json',
  });

  const uploadRes = await axios.post(
    `https://graph.facebook.com/v22.0/${flowId}/assets`,
    form,
    { headers: { ...authHeader, ...form.getHeaders() } }
  );
  console.log(`[flows] Uploaded JSON:`, JSON.stringify(uploadRes.data));

  // 3. Publish flow
  await axios.post(
    `https://graph.facebook.com/v22.0/${flowId}?publish=true`,
    {},
    { headers: authHeader }
  );
  console.log(`[flows] Published flow ${flowId}`);

  flowCache.set(cacheKey, flowId);
  return flowId;
}

module.exports = { getOrCreateFlow };
