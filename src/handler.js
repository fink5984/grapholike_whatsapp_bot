const axios = require('axios');
const { getCategories, getGreetingsByCategory, getGreetingById } = require('./catalog');
const {
  sendText,
  sendImage,
  sendCategoryList,
  sendGreetingCarousel,
  sendGreetingList,
  sendButtons,
  markAsRead,
  sendTyping,
  sendFlowMessage,
  sendCtaUrl,
} = require('./whatsapp');
const { getSession, setSession, deleteSession } = require('./sessions');
const { getGreetingFlow } = require('./flows');
const { getProfile, setProfile, getLastOrder, setLastOrder } = require('./profiles');
const { createPayment, markPaid } = require('./payments');
const M = require('./messages');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isImageUrl(url) {
  if (!url) return false;
  const clean = String(url).split('?')[0].toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.webp', '.gif'].some((ext) => clean.endsWith(ext));
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

/**
 * מזהה ההזמנה שנוצרה ב-/create, לצורך /update בשלב התיקון.
 * מנסה קודם שדה מפורש בתשובה, ואם אין — מחלץ את המספר משם קובץ התמונה
 * (למשל ".../--385782.jpg" → "385782").
 */
function extractOrderId(data, fileUrl) {
  const fromData = data?.order_id ?? data?.id ?? data?.post_id ?? data?.data?.order_id;
  if (fromData != null && fromData !== '') return String(fromData);
  const match = String(fileUrl || '').match(/(\d+)\.[a-z0-9]+(?:\?.*)?$/i);
  return match ? match[1] : null;
}

/**
 * מוסיף פרמטר cache-busting לכתובת התמונה. תיקון (/update) מייצר את הקובץ
 * באותו שם, כך שבלי זה וואטסאפ/הדפדפן מציגים תצוגה שמורה של העיצוב הישן.
 */
function withCacheBuster(url) {
  if (!url) return url;
  const sep = String(url).includes('?') ? '&' : '?';
  return `${url}${sep}v=${Date.now()}`;
}

function normalizeFlowResponseFields(responseJson) {
  const obj = responseJson && typeof responseJson === 'object' ? responseJson : {};
  console.log('[handler] nfm_reply raw:', JSON.stringify(obj));

  const greetingId = obj.greeting_id || obj.greetingId;

  const ignored = new Set(['greeting_id', 'greetingId', 'form', 'flow_token', 'screen', 'version']);
  const fields = Object.fromEntries(
    Object.entries(obj).filter(
      ([key, value]) =>
        !ignored.has(key) && value !== '' && value != null && typeof value !== 'object'
    )
  );

  return { greetingId, fields };
}

/**
 * עיבוד הודעה נכנסת מ-WhatsApp
 * phoneNumberId — נלקח מ-value.metadata.phone_number_id בתוך ה-webhook
 */
async function handleMessage(message, contact, phoneNumberId) {
  const phone = message.from;
  const type = message.type;

  console.log(`[handler] phone=${phone} type=${type} phoneNumberId=${phoneNumberId}`);

  await markAsRead(phoneNumberId, message.id);
  await sendTyping(phoneNumberId, message.id);

  // ביטול סשן אם המשתמש מבקש לחזור לתפריט
  if (type === 'text') {
    const textBody = (message.text?.body || '').trim();
    if (textBody === 'ביטול' || textBody === 'התחל' || textBody === 'תפריט') {
      deleteSession(phone);
    }
  }

  // ── סשן Q&A פעיל (fallback כאשר Flow אינו זמין) ──
  const session = getSession(phone);
  console.log(`[handler] session=${session ? 'ACTIVE kind=' + (session.kind || 'greeting') : 'none'}`);
  if (session && type === 'text') {
    const text = (message.text?.body || '').trim();
    await handleSessionInput(phone, phoneNumberId, session, text);
    return;
  }

  // ── תגובות אינטראקטיביות ──
  if (type === 'interactive') {
    const interactiveType = message.interactive?.type;

    // שלב 7/13 — סיום מילוי Flow פרטי האירוע
    if (interactiveType === 'nfm_reply') {
      const responseJson = JSON.parse(message.interactive.nfm_reply.response_json);
      const { greetingId, fields } = normalizeFlowResponseFields(responseJson);
      await handleEventFormComplete(phoneNumberId, phone, parseInt(greetingId, 10), fields);
      return;
    }

    let selectedId = '';
    let selectedTitle = '';
    if (interactiveType === 'list_reply') {
      selectedId = message.interactive.list_reply?.id || '';
      selectedTitle = message.interactive.list_reply?.title || '';
    } else if (interactiveType === 'button_reply') {
      selectedId = message.interactive.button_reply?.id || '';
      selectedTitle = message.interactive.button_reply?.title || '';
    }
    console.log(`[handler] interactive type=${interactiveType} selectedId=${selectedId}`);

    // שלב 3–4 — בחירת קטגוריה → הצגת עיצובים
    if (selectedId.startsWith('cat_')) {
      await handleCategorySelected(phoneNumberId, phone, selectedId.replace('cat_', ''), selectedTitle);
      return;
    }

    // שלב 5 — בחירת עיצוב (מתוך רשימת fallback)
    if (selectedId.startsWith('choose_greeting_')) {
      await handleDesignChosen(phoneNumberId, phone, selectedId.replace('choose_greeting_', ''));
      return;
    }

    // שלב 6 — לחיצה על "הזנת פרטי האירוע"
    if (selectedId.startsWith('open_event_form_')) {
      await handleOpenEventForm(phoneNumberId, phone, selectedId.replace('open_event_form_', ''));
      return;
    }

    // שלב 13 — לחיצה על "תיקון ההזמנה"
    if (selectedId === 'edit_order') {
      await handleEditOrder(phoneNumberId, phone);
      return;
    }
    return;
  }

  // שלב 5 — בחירת עיצוב מהקרוסלה מגיעה כ-type=button (quick_reply)
  if (type === 'button') {
    const payload = message.button?.payload || '';
    console.log(`[handler] button payload=${payload}`);
    if (payload.startsWith('choose_greeting_')) {
      await handleDesignChosen(phoneNumberId, phone, payload.replace('choose_greeting_', ''));
    } else if (payload.startsWith('open_event_form_')) {
      await handleOpenEventForm(phoneNumberId, phone, payload.replace('open_event_form_', ''));
    }
    return;
  }

  // ── הודעת טקסט רגילה ──
  if (type === 'text') {
    const profile = getProfile(phone);
    if (!profile) {
      // שלב 1 — פתיחה + איסוף שם ומייל
      await sendText(phoneNumberId, phone, M.OPENING);
      await startOnboarding(phoneNumberId, phone);
    } else {
      // לקוח חוזר — ישר לבחירת קטגוריה
      await sendText(phoneNumberId, phone, M.welcomeBack(profile.name));
      await showCategories(phoneNumberId, phone);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// שלב 1 — onboarding (שם + מייל) בשתי שאלות טקסט נפרדות
// ─────────────────────────────────────────────────────────────
async function startOnboarding(phoneNumberId, phone) {
  setSession(phone, { kind: 'onboarding', step: 'name', collected: {}, phoneNumberId });
  await sendText(phoneNumberId, phone, M.ASK_NAME);
}

// ─────────────────────────────────────────────────────────────
// שלב 3–4 — קטגוריות ועיצובים
// ─────────────────────────────────────────────────────────────
async function showCategories(phoneNumberId, phone) {
  let categories;
  try {
    categories = await getCategories();
  } catch (err) {
    // כשל בשליפת הקטלוג (למשל WAF שחוסם את שרת האירוח) — מודיעים ללקוח
    // במקום להשאיר אותו בלי תגובה, והפרטים המלאים נרשמים ב-[catalog] בלוג.
    console.error('[handler] getCategories failed:', err.message);
    await sendText(phoneNumberId, phone, M.ERR_NO_CATEGORIES);
    return;
  }
  if (categories.length === 0) {
    await sendText(phoneNumberId, phone, M.ERR_NO_CATEGORIES);
    return;
  }
  await sendCategoryList(phoneNumberId, phone, M.CATEGORY_LIST_BODY, categories);
}

async function handleCategorySelected(phoneNumberId, phone, categoryId, categoryTitle) {
  await sendText(phoneNumberId, phone, M.loadingDesigns(categoryTitle));

  let greetings;
  try {
    greetings = await getGreetingsByCategory(categoryId);
  } catch (err) {
    console.error('[handler] getGreetingsByCategory error:', err.message);
    await sendText(phoneNumberId, phone, M.ERR_LOAD_DESIGNS);
    return;
  }

  if (!greetings || greetings.length === 0) {
    await sendText(phoneNumberId, phone, M.noDesignsForCategory(categoryTitle));
    return;
  }

  await sendText(phoneNumberId, phone, M.DESIGNS_INTRO);
  try {
    await sendGreetingCarousel(phoneNumberId, phone, categoryTitle, greetings);
  } catch (carouselErr) {
    console.warn('[handler] carousel failed, falling back to list:', carouselErr.message);
    await sendGreetingList(phoneNumberId, phone, categoryTitle, greetings);
  }
}

// ─────────────────────────────────────────────────────────────
// שלב 5 — נבחר עיצוב → כפתור "הזנת פרטי האירוע"
// ─────────────────────────────────────────────────────────────
async function handleDesignChosen(phoneNumberId, phone, greetingId) {
  const greeting = await getGreetingById(greetingId);
  if (!greeting || !greeting.content || greeting.content.length === 0) {
    await sendText(phoneNumberId, phone, M.ERR_LOAD_GREETING);
    return;
  }
  await sendButtons(phoneNumberId, phone, M.DESIGN_CHOSEN, [
    { id: `open_event_form_${greetingId}`, title: M.BTN_FILL_DETAILS },
  ]);
}

// ─────────────────────────────────────────────────────────────
// שלב 6–7 — "לפני שמתחילים" + פתיחת טופס פרטי האירוע
// ─────────────────────────────────────────────────────────────
async function handleOpenEventForm(phoneNumberId, phone, greetingId) {
  const greeting = await getGreetingById(greetingId);
  if (!greeting || !greeting.content || greeting.content.length === 0) {
    await sendText(phoneNumberId, phone, M.ERR_LOAD_GREETING);
    return;
  }
  await sendText(phoneNumberId, phone, M.BEFORE_FORM);
  await openGreetingForm(phoneNumberId, phone, greeting, {
    bodyText: 'למילוי פרטי האירוע לחצו על הכפתור 👇',
  });
}

/**
 * פותח את Flow פרטי האירוע, עם נפילה ל-Q&A אם ה-Flow אינו זמין.
 * prefill — מפת param→ערך לפתיחת הטופס מלא (תיקון, שלב 13). מילוי ראשון פותח ריק.
 */
async function openGreetingForm(phoneNumberId, phone, greeting, { bodyText, prefill } = {}) {
  try {
    const flowId = await getGreetingFlow(greeting);
    // init_values ממלא את הטופס מראש — רק ערכים שבאמת קיימים. שליחת מחרוזת
    // ריקה לשדה חובה גורמת לוואטסאפ להתייחס אליו כ"מולא וריק" ולהציג את
    // שגיאת החובה באדום מיד עם פתיחת הטופס.
    const initValues = {};
    for (const field of greeting.content || []) {
      const value = prefill ? prefill[field.param] : undefined;
      if (value != null && String(value).trim() !== '') {
        initValues[field.param] = String(value);
      }
    }
    await sendFlowMessage(phoneNumberId, phone, flowId, {
      bodyText: bodyText || 'מלא את הפרטים לעיצוב',
      headerText: 'פרטי האירוע',
      cta: 'מילוי פרטים',
      screen: 'GREETING_FORM',
      data: { init_values: initValues },
    });
  } catch (err) {
    console.error('[handler] greeting flow failed, Q&A fallback:', err.message, err.response?.data);
    setSession(phone, {
      kind: 'greeting',
      greetingId: parseInt(greeting.id, 10),
      fields: greeting.content,
      currentFieldIndex: 0,
      collected: { phone },
      phoneNumberId,
    });
    const firstField = greeting.content[0];
    await sendText(
      phoneNumberId,
      phone,
      `נמלא יחד את הפרטים.\nשלחו "ביטול" בכל שלב לחזרה לתפריט.\n\n(1/${greeting.content.length}) ${firstField.name}:`
    );
  }
}

// ─────────────────────────────────────────────────────────────
// שלב 13 — פתיחת תיקון
// ─────────────────────────────────────────────────────────────
async function handleEditOrder(phoneNumberId, phone) {
  const order = getLastOrder(phone);
  if (!order || !order.greetingId) {
    await sendText(phoneNumberId, phone, 'לא נמצאה הזמנה אחרונה לתיקון.');
    return;
  }
  if (order.createdAt && Date.now() - order.createdAt > M.CORRECTION_WINDOW_MS) {
    await sendText(phoneNumberId, phone, M.CORRECTION_EXPIRED);
    return;
  }

  const greeting = await getGreetingById(order.greetingId);
  if (!greeting || !greeting.content || greeting.content.length === 0) {
    await sendText(phoneNumberId, phone, M.ERR_LOAD_GREETING);
    return;
  }

  setLastOrder(phone, { editing: true });
  await openGreetingForm(phoneNumberId, phone, greeting, {
    bodyText: 'הפרטים כבר מלאים — ערכו את מה שצריך ושלחו שוב 👇',
    prefill: order.fields, // פתיחת הטופס מלא בערכים מההזמנה המקורית
  });
}

// ─────────────────────────────────────────────────────────────
// שלב 7/14 — סיום טופס פרטי האירוע → תשלום (יצירה ראשונה) / יצירת העיצוב (תיקון)
// ─────────────────────────────────────────────────────────────
async function handleEventFormComplete(phoneNumberId, phone, greetingId, fields) {
  const order = getLastOrder(phone);
  const isCorrection = !!order?.editing;
  console.log(`[handler] event form complete greetingId=${greetingId} correction=${isCorrection}`);

  if (isCorrection) {
    // תיקון בחלון 24 השעות הוא חינמי — אין שלב תשלום, ישר ליצירה מחדש
    await sendText(phoneNumberId, phone, M.CORRECTION_RECEIVED); // שלב 14
    await generateAndSend(phoneNumberId, phone, greetingId, { ...fields, phone }, { correction: true });
    return;
  }

  await sendText(phoneNumberId, phone, M.FORM_DONE); // שלב 8

  // שלב 9 — שליחת קישור לדף התשלום. יצירת העיצוב תופעל רק לאחר אישור
  // התשלום (handlePaymentConfirmed). אם התשלום אינו מוגדר בסביבה — ממשיכים
  // ישר ליצירה כדי לא לתקוע את הבוט.
  const paymentStarted = await startPaymentStep(phoneNumberId, phone, greetingId, fields);
  if (!paymentStarted) {
    await generateAndSend(phoneNumberId, phone, greetingId, { ...fields, phone }, { correction: false });
  }
}

// ─────────────────────────────────────────────────────────────
// שלב 9 — יצירת תשלום ממתין ושליחת קישור לדף התשלום (נדרים פלוס)
// ─────────────────────────────────────────────────────────────

// !!! מחיר זמני לתקופת הניסויים — כל העיצובים ב-₪5 !!!
// להחזיר למחרוזת ריקה ('') לפני עלייה לאוויר כדי לחזור למחירי הקטלוג.
const TEST_AMOUNT_OVERRIDE = '5';

async function startPaymentStep(phoneNumberId, phone, greetingId, fields) {
  const baseUrl = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl || !process.env.NEDARIM_MOSAD_ID || !process.env.NEDARIM_API_VALID) {
    console.warn('[handler] payment env not configured (PUBLIC_BASE_URL / NEDARIM_*) — skipping payment step');
    return false;
  }

  let greeting = null;
  try {
    greeting = await getGreetingById(greetingId);
  } catch (err) {
    console.warn('[handler] could not load greeting for payment:', err.message);
  }

  const catalogAmount = String(greeting?.price ?? process.env.PAYMENT_DEFAULT_AMOUNT ?? '').trim();
  const amount = TEST_AMOUNT_OVERRIDE || catalogAmount;
  if (TEST_AMOUNT_OVERRIDE) {
    console.warn(`[handler] TEST price override active — charging ₪${amount} instead of ₪${catalogAmount}`);
  }
  if (!(parseFloat(amount) > 0)) {
    console.warn(`[handler] no valid price for greeting ${greetingId} — skipping payment step`);
    return false;
  }

  const profile = getProfile(phone);
  const payment = createPayment({
    phone,
    phoneNumberId,
    greetingId,
    fields,
    amount,
    image: greeting?.image || '',
    customer: { name: profile?.name || '', email: profile?.email || '', phone },
  });

  const link = `${baseUrl}/pay/${payment.token}`;
  console.log(`[handler] payment link created token=${payment.token} amount=${amount}`);
  try {
    // הודעת כפתור שפותח את דף התשלום ישירות
    await sendCtaUrl(phoneNumberId, phone, {
      headerText: M.PAYMENT_HEADER,
      bodyText: M.paymentRequestBody(amount),
      buttonText: M.BTN_PAY,
      url: link,
      footerText: M.PAYMENT_FOOTER,
    });
  } catch (err) {
    console.warn('[handler] cta_url payment message failed, sending text link:', err.message);
    await sendText(phoneNumberId, phone, M.paymentRequest(amount, link));
  }
  return true;
}

// ─────────────────────────────────────────────────────────────
// שלב 10 — אישור תשלום → הודעת המשך + יצירת העיצוב
// נקרא משני מסלולים: אישור מדף התשלום (צד לקוח) ו-CallBack של נדרים (צד שרת).
// markPaid אידמפוטנטי, כך שהמסלול השני שמגיע לא יוצר עיצוב כפול.
// ─────────────────────────────────────────────────────────────
async function handlePaymentConfirmed(token, transaction, source = 'client') {
  // הגנה נוספת (מעבר לסינון בראוטים): לעולם לא לאשר עסקה שסטטוסה שגיאה.
  if (String(transaction?.Status || '').toLowerCase() === 'error') {
    console.warn(`[handler] payment confirm REJECTED — transaction status=Error token=${token} source=${source}`);
    return false;
  }

  const payment = markPaid(token, transaction);
  if (!payment) {
    console.log(`[handler] payment confirm ignored (unknown/already paid) token=${token} source=${source}`);
    return false;
  }

  console.log(`[handler] payment CONFIRMED token=${token} source=${source} amount=${payment.amount}`);
  const { phoneNumberId, phone, greetingId, fields } = payment;

  await sendText(phoneNumberId, phone, M.PAYMENT_SUCCESS); // שלב 10 — העסקה אושרה
  await generateAndSend(phoneNumberId, phone, greetingId, { ...fields, phone }, { correction: false });
  return true;
}

// ─────────────────────────────────────────────────────────────
// שלב 11–12 / 15 — יצירת העיצוב ושליחתו
// ─────────────────────────────────────────────────────────────
async function generateAndSend(phoneNumberId, phone, greetingId, fields, { correction = false } = {}) {
  const profile = getProfile(phone);

  // שלב 11 — הודעות התקדמות (רק ביצירה ראשונה; בתיקון כבר נשלחה הודעת שלב 14)
  if (!correction) {
    for (const text of M.PROGRESS) {
      await sendText(phoneNumberId, phone, text);
      await sleep(700);
    }
  }

  try {
    const order = getLastOrder(phone);
    // תיקון (שלב 13) מרנדר מחדש את ההזמנה הקיימת דרך /update עם order_id;
    // יצירה ראשונה יוצרת הזמנה חדשה דרך /create עם post_id.
    const orderId = order?.orderId;
    const useUpdate = correction && orderId;
    if (correction && !orderId) {
      console.warn('[handler] correction requested but no stored order_id — falling back to /create');
    }

    let endpoint;
    let body;
    if (useUpdate) {
      endpoint = `${process.env.CATALOG_BASE_URL}/update`;
      body = { order_id: orderId, ...fields, generate_pdf: true };
      // ה-backend שולח את המייל באיכות גבוהה — מעבירים לו את כתובת הלקוח (mail)
      if (profile?.email && body.mail == null) body.mail = profile.email;
    } else {
      endpoint = `${process.env.CATALOG_BASE_URL}/create`;
      body = { post_id: greetingId, ...fields, generate_pdf: true };
      if (profile?.email) body.email = profile.email;
      if (profile?.name) body.customer_name = profile.name;
    }

    console.log(`[handler] ${useUpdate ? 'updating' : 'creating'} ecard:`, JSON.stringify(body));
    const { data } = await axios.post(endpoint, body, {
      headers: { 'X-ECARD-API-KEY': process.env.CATALOG_API_KEY },
    });
    console.log(`[handler] ${useUpdate ? 'update' : 'create'} response:`, JSON.stringify(data));

    const rawFileUrl =
      data.image_url || data.url || data.pdf_url || data.file_url || data.download_url ||
      data.link || data.data?.image_url || data.data?.url || data.result?.image_url || data.result?.url;

    // /update מייצר את הקובץ באותו שם — cache-busting מכריח טעינה מחדש של הגרסה המעודכנת.
    const fileUrl = withCacheBuster(rawFileUrl);

    const caption = correction ? M.CORRECTED_CAPTION : M.DELIVERED_CAPTION;

    if (fileUrl && isImageUrl(fileUrl)) {
      try {
        await sendImage(phoneNumberId, phone, fileUrl, caption);
      } catch (imgErr) {
        console.warn('[handler] sendImage failed, sending link instead:', imgErr.message);
        await sendText(phoneNumberId, phone, `${caption}\n\n${fileUrl}`);
      }
    } else if (fileUrl) {
      await sendText(phoneNumberId, phone, `${caption}\n\n${fileUrl}`);
    } else {
      await sendText(phoneNumberId, phone, `${caption}\n\n${JSON.stringify(data, null, 2).slice(0, 1000)}`);
    }

    // שמירת ההזמנה לצורך חלון התיקונים (שלב 13). ביצירה ראשונה קובעים createdAt
    // ושומרים את order_id שהוחזר, כדי שתיקון עתידי יקרא ל-/update על אותה הזמנה.
    const newOrderId = useUpdate ? orderId : extractOrderId(data, rawFileUrl);
    setLastOrder(phone, {
      greetingId,
      fields,
      editing: false,
      ...(newOrderId ? { orderId: newOrderId } : {}),
      ...(correction ? {} : { createdAt: Date.now() }),
    });

    if (!correction) {
      await sendText(phoneNumberId, phone, M.EMAIL_NOTE); // שלב 12 — הודעת מייל
      await sendButtons(phoneNumberId, phone, M.CORRECTIONS_OFFER, [
        { id: 'edit_order', title: M.BTN_EDIT_ORDER },
      ]); // שלב 13
    }
  } catch (err) {
    console.error('[handler] create error:', err.message, err.response?.data);
    await sendText(phoneNumberId, phone, M.ERR_CREATE);
  }
}

// ─────────────────────────────────────────────────────────────
// Q&A fallback — מילוי שדות בטקסט כאשר Flow אינו זמין
// ─────────────────────────────────────────────────────────────
async function handleSessionInput(phone, phoneNumberId, session, text) {
  // fallback של onboarding (שם → מייל)
  if (session.kind === 'onboarding') {
    if (session.step === 'name') {
      setSession(phone, { ...session, step: 'email', collected: { ...session.collected, name: text } });
      await sendText(phoneNumberId, phone, M.ASK_EMAIL);
      return;
    }
    // step === 'email'
    if (!isValidEmail(text)) {
      await sendText(phoneNumberId, phone, 'נראה שכתובת המייל אינה תקינה. נסו שוב 🙏');
      return;
    }
    const name = (session.collected.name || '').trim() || 'לקוח';
    deleteSession(phone);
    setProfile(phone, { name, email: text.trim() });
    await sendText(phoneNumberId, phone, M.afterDetails(name));
    await showCategories(phoneNumberId, phone);
    return;
  }

  // fallback של מילוי פרטי האירוע
  const { fields, currentFieldIndex, collected, greetingId } = session;
  const currentField = fields[currentFieldIndex];
  collected[currentField.param] = text;

  const nextIndex = currentFieldIndex + 1;
  if (nextIndex < fields.length) {
    setSession(phone, { ...session, currentFieldIndex: nextIndex, collected });
    const nextField = fields[nextIndex];
    await sendText(phoneNumberId, phone, `(${nextIndex + 1}/${fields.length}) ${nextField.name}:`);
    return;
  }

  deleteSession(phone);
  await handleEventFormComplete(phoneNumberId, phone, greetingId, collected);
}

module.exports = { handleMessage, handlePaymentConfirmed };
