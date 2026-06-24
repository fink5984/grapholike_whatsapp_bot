const axios = require('axios');
const FormData = require('form-data');

const flowCache = new Map(); // flow key -> flowId

function helperTextForField(field) {
  const param = String(field?.param || '').trim().toLowerCase();
  const name = String(field?.name || '').trim();

  const examples = {
    day: 'לדוגמה: ראשון',
    parsha: 'לדוגמה: בראשית',
    date: 'לדוגמה: י"ב',
    month: 'לדוגמה: תשרי',
    year: 'לדוגמה: תשפ"ו',
    city: 'לדוגמה: ירושלים',
    address: 'לדוגמה: רחוב הרצל 10',
    name: 'לדוגמה: דוד',
    father: 'לדוגמה: משה',
    mother: 'לדוגמה: שרה',
    phone: 'לדוגמה: 0521234567',
  };

  if (examples[param]) return examples[param];

  const normalizedName = name.toLowerCase();
  if (normalizedName.includes('יום')) return 'לדוגמה: ראשון';
  if (normalizedName.includes('פרשה')) return 'לדוגמה: בראשית';
  if (normalizedName.includes('תאריך')) return 'לדוגמה: י"ב';
  if (normalizedName.includes('חודש')) return 'לדוגמה: תשרי';
  if (normalizedName.includes('שנה')) return 'לדוגמה: תשפ"ו';
  if (normalizedName.includes('עיר')) return 'לדוגמה: ירושלים';
  if (normalizedName.includes('כתובת')) return 'לדוגמה: רחוב הרצל 10';
  if (normalizedName.includes('טלפון')) return 'לדוגמה: 0521234567';

  return 'לדוגמה: מלא כאן את הפרט המבוקש';
}

// Bump this version when flow JSON structure changes to force fresh flows.
// v4: greeting form now declares screen `data` + init-value bindings so the
//     correction step (13) can reopen the flow pre-filled with existing values.
const FLOW_NAME_VERSION = 'v4';

async function findExistingFlowId(authHeader, wabaId, keyPrefix) {
  const prefix = `${keyPrefix}_${FLOW_NAME_VERSION}`;

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

async function createFlowWithUniqueName(authHeader, wabaId, keyPrefix) {
  const baseName = `${keyPrefix}_${FLOW_NAME_VERSION}`;
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

async function uploadAndPublishFlow(authHeader, flowId, flowJson) {
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

  const validationErrors = Array.isArray(uploadRes.data?.validation_errors)
    ? uploadRes.data.validation_errors
    : [];
  if (validationErrors.length > 0) {
    const firstError = validationErrors[0];
    throw new Error(`Flow JSON validation failed: ${firstError?.message || 'unknown validation error'}`);
  }

  await axios.post(
    `https://graph.facebook.com/v22.0/${flowId}/publish`,
    {},
    { headers: authHeader }
  );
  console.log(`[flows] Published flow ${flowId}`);
}

/**
 * Flow לאיסוף פרטי האירוע (שלב 7).
 * השדות נטענים דינמית מתוך greeting.content.
 * הערה: WhatsApp לא תומך ב-init-value על TextInput, ולכן אין prefill —
 * תיקון (שלב 13) פותח מחדש טופס ריק והמשתמש מזין את הפרטים שוב.
 */
function buildGreetingFlowJson(greeting) {
  const fields = greeting.content || [];

  const formChildren = fields.map((field) => ({
    type: 'TextInput',
    label: String(field.name || field.param || 'שדה'),
    name: field.param,
    'input-type': field.param === 'phone' ? 'phone' : 'text',
    'helper-text': helperTextForField(field),
    required: true,
  }));

  // Pass each form input value back to the bot via ${form.<name>} data-binding.
  const payload = { greeting_id: String(greeting.id) };
  for (const field of fields) {
    payload[field.param] = `\${form.${field.param}}`;
  }

  formChildren.push({
    type: 'Footer',
    label: 'שלח ברכה',
    'on-click-action': {
      name: 'complete',
      payload,
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

/**
 * Flow לאיסוף שם + מייל (שלב 1).
 * נוסחת ה-complete מסומנת ב-form:'onboarding' כדי שה-handler יבדיל בינו
 * לבין טופס פרטי האירוע.
 */
function buildOnboardingFlowJson() {
  return {
    version: '6.0',
    screens: [
      {
        id: 'ONBOARDING_FORM',
        title: 'פרטים אישיים',
        terminal: true,
        success: true,
        data: {},
        layout: {
          type: 'SingleColumnLayout',
          children: [
            {
              type: 'Form',
              name: 'onboarding_form',
              children: [
                {
                  type: 'TextInput',
                  label: 'איך קוראים לכם?',
                  name: 'name',
                  'input-type': 'text',
                  required: true,
                },
                {
                  type: 'TextInput',
                  label: 'כתובת מייל',
                  name: 'email',
                  'input-type': 'email',
                  'helper-text': 'לשם נשלח את העיצוב באיכות גבוהה',
                  required: true,
                },
                {
                  type: 'Footer',
                  label: 'המשך',
                  'on-click-action': {
                    name: 'complete',
                    payload: {
                      form: 'onboarding',
                      name: '${form.name}',
                      email: '${form.email}',
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

/**
 * מאתר/יוצר/מפרסם Flow לפי מפתח לוגי (key) ומחזיר את ה-flowId.
 * key לדוגמה: "greeting_123" או "onboarding".
 */
async function getOrCreateFlowByKey(key, flowJson) {
  const WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!WABA_ID) {
    throw new Error('WHATSAPP_BUSINESS_ACCOUNT_ID env var is not set');
  }

  if (flowCache.has(key)) {
    console.log(`[flows] Using cached flow for ${key}`);
    return flowCache.get(key);
  }

  const authHeader = { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };

  let existingFlowId = null;
  try {
    existingFlowId = await findExistingFlowId(authHeader, WABA_ID, key);
  } catch (listErr) {
    console.warn('[flows] Could not list existing flows, creating a new one:', listErr.message);
  }

  if (existingFlowId) {
    console.log(`[flows] Reusing existing flow ${existingFlowId} for ${key}`);
    await uploadAndPublishFlow(authHeader, existingFlowId, flowJson);
    flowCache.set(key, existingFlowId);
    return existingFlowId;
  }

  console.log(`[flows] Creating flow for ${key}`);
  const flowId = await createFlowWithUniqueName(authHeader, WABA_ID, key);
  console.log(`[flows] Created flow id=${flowId}`);

  await uploadAndPublishFlow(authHeader, flowId, flowJson);

  flowCache.set(key, flowId);
  return flowId;
}

function getGreetingFlow(greeting) {
  return getOrCreateFlowByKey(`greeting_${greeting.id}`, buildGreetingFlowJson(greeting));
}

function getOnboardingFlow() {
  return getOrCreateFlowByKey('onboarding', buildOnboardingFlowJson());
}

module.exports = { getGreetingFlow, getOnboardingFlow };
