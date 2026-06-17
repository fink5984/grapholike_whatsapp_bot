const axios = require('axios');
const FormData = require('form-data');

const flowCache = new Map(); // greetingId -> flowId

async function findExistingFlowId(authHeader, wabaId, greetingId) {
  const prefix = `greeting_${greetingId}`;

  const { data } = await axios.get(
    `https://graph.facebook.com/v22.0/${wabaId}/flows`,
    {
      headers: authHeader,
      params: { fields: 'id,name,status', limit: 200 },
    }
  );

  const flows = Array.isArray(data?.data) ? data.data : [];
  const existing = flows.find((f) => typeof f.name === 'string' && f.name.startsWith(prefix));
  return existing?.id || null;
}

async function createFlowWithUniqueName(authHeader, wabaId, greetingId) {
  const baseName = `greeting_${greetingId}`;
  let flowName = `${baseName}_${Date.now()}`;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const createRes = await axios.post(
        `https://graph.facebook.com/v22.0/${wabaId}/flows`,
        { name: flowName, categories: ['OTHER'] },
        { headers: authHeader }
      );
      return createRes.data.id;
    } catch (err) {
      const subcode = err.response?.data?.error?.error_subcode;
      if (subcode !== 4016019 || attempt === 2) {
        throw err;
      }
      flowName = `${baseName}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    }
  }

  throw new Error('Failed creating unique flow name');
}

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

  try {
    const existingFlowId = await findExistingFlowId(authHeader, WABA_ID, greeting.id);
    if (existingFlowId) {
      console.log(`[flows] Reusing existing flow ${existingFlowId} for greeting ${greeting.id}`);
      flowCache.set(cacheKey, existingFlowId);
      return existingFlowId;
    }
  } catch (listErr) {
    console.warn('[flows] Could not list existing flows, creating a new one:', listErr.message);
  }

  console.log(`[flows] Creating flow for greeting ${greeting.id}`);

  // 1. Create flow
  const flowId = await createFlowWithUniqueName(authHeader, WABA_ID, greeting.id);
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
    `https://graph.facebook.com/v22.0/${flowId}/publish`,
    {},
    { headers: authHeader }
  );
  console.log(`[flows] Published flow ${flowId}`);

  flowCache.set(cacheKey, flowId);
  return flowId;
}

module.exports = { getOrCreateFlow };
