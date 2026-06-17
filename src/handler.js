const axios = require('axios');
const { getCategories, getGreetingsByCategory, getGreetingById } = require('./catalog');
const { sendText, sendImage, sendCategoryList, sendGreetingCarousel, sendGreetingList, markAsRead, sendTyping, sendFlowMessage } = require('./whatsapp');
const { getSession, setSession, deleteSession } = require('./sessions');
const { getOrCreateFlow } = require('./flows');

function isImageUrl(url) {
  if (!url) return false;
  const clean = String(url).split('?')[0].toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.webp', '.gif'].some((ext) => clean.endsWith(ext));
}

function normalizeFlowResponseFields(responseJson) {
  const obj = responseJson && typeof responseJson === 'object' ? responseJson : {};

  // Log raw payload to diagnose field extraction issues
  console.log('[handler] nfm_reply raw:', JSON.stringify(obj));

  const greetingId = obj.greeting_id || obj.greetingId;

  const ignored = new Set(['greeting_id', 'greetingId', 'flow_token', 'screen', 'version']);
  const fields = Object.fromEntries(
    Object.entries(obj).filter(
      ([key, value]) =>
        !ignored.has(key) &&
        value !== '' &&
        value != null &&
        typeof value !== 'object'
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
  const name = contact?.profile?.name || 'לקוח';
  const type = message.type;

  console.log(`[handler] phone=${phone} type=${type} phoneNumberId=${phoneNumberId}`);

  // אישור קריאה + אינדיקטור typing על ההודעה שנכנסה
  await markAsRead(phoneNumberId, message.id);
  await sendTyping(phoneNumberId, message.id);

  // ביטול סשן אם המשתמש מבקש לחזור לתפריט
  if (type === 'text') {
    const textBody = (message.text?.body || '').trim();
    if (textBody === 'ביטול' || textBody === 'התחל' || textBody === 'תפריט') {
      deleteSession(phone);
    }
  }

  // אם יש סשן פעיל — המשתמש במצב מילוי שדות
  const session = getSession(phone);
  console.log(`[handler] session=${session ? 'ACTIVE field=' + session.currentFieldIndex : 'none'}`);

  if (session && type === 'text') {
    const text = (message.text?.body || '').trim();
    console.log(`[handler] collecting field answer: "${text}"`);
    await handleSessionInput(phone, phoneNumberId, session, text);
    return;
  }

  // הודעת טקסט — פתיחת תפריט קטגוריות
  if (type === 'text') {
    console.log('[handler] new text message → showing categories');
    const categories = await getCategories();
    if (categories.length === 0) {
      await sendText(phoneNumberId, phone, 'מצטערים, לא נמצאו קטגוריות כרגע. נסה שוב מאוחר יותר.');
      return;
    }
    await sendCategoryList(phoneNumberId, phone, name, categories);
    return;
  }

  // כפתור quick_reply מקרוסלה (type=button)
  if (type === 'button') {
    const payload = message.button?.payload || '';
    console.log(`[handler] button payload=${payload}`);
    if (payload.startsWith('choose_greeting_')) {
      console.log(`[handler] greeting selected via button: ${payload}`);
      const greetingId = payload.replace('choose_greeting_', '');
      console.log(`[handler] fetching greeting id=${greetingId}`);
      const greeting = await getGreetingById(greetingId);
      console.log(`[handler] greeting found=${!!greeting} fields=${greeting?.content?.length}`);

      if (!greeting || !greeting.content || greeting.content.length === 0) {
        await sendText(phoneNumberId, phone, 'שגיאה בטעינת פרטי הברכה. נסה שוב.');
        return;
      }

      try {
        const flowId = await getOrCreateFlow(greeting);
        await sendFlowMessage(phoneNumberId, phone, flowId, `מלא את הפרטים לברכה:`);
      } catch (err) {
        console.error('[handler] Flow creation failed, falling back to Q&A:', err.message, err.response?.data);
        setSession(phone, {
          greetingId: parseInt(greetingId),
          fields: greeting.content,
          currentFieldIndex: 0,
          collected: { phone },
          phoneNumberId,
        });
        const firstField = greeting.content[0];
        await sendText(
          phoneNumberId,
          phone,
          `בחרת ברכה! נמלא יחד את הפרטים.\n\nשלח "ביטול" בכל שלב לחזרה לתפריט.\n\n` +
          `(1/${greeting.content.length}) ${firstField.name}:`
        );
      }
    }
    return;
  }

  // תגובה אינטראקטיבית
  if (type === 'interactive') {
    const interactiveType = message.interactive?.type;
    let selectedId = '';
    let selectedTitle = '';

    if (interactiveType === 'nfm_reply') {
      const responseJson = JSON.parse(message.interactive.nfm_reply.response_json);
      const { greetingId, fields } = normalizeFlowResponseFields(responseJson);
      const parsedGreetingId = parseInt(greetingId, 10);

      console.log(
        `[handler] nfm_reply greetingId=${greetingId} fieldKeys=${Object.keys(fields).join(',')} fields=${JSON.stringify(fields)}`
      );
      const sanitizedFields = fields;
      await createEcard(phoneNumberId, phone, parsedGreetingId, { ...sanitizedFields, phone });
      return;
    }

    if (interactiveType === 'list_reply') {
      selectedId = message.interactive.list_reply?.id || '';
      selectedTitle = message.interactive.list_reply?.title || '';
    } else if (interactiveType === 'button_reply') {
      selectedId = message.interactive.button_reply?.id || '';
      selectedTitle = message.interactive.button_reply?.title || '';
    }

    console.log(`[handler] interactive: type=${interactiveType} selectedId=${selectedId}`);

    // בחירת קטגוריה → מציג קרוסלה של ברכות
    if (selectedId.startsWith('cat_')) {
      console.log(`[handler] category selected: ${selectedId}`);
      const categoryId = selectedId.replace('cat_', '');
      console.log(`[handler] fetching greetings for category ${categoryId}`);
      let greetings;
      try {
        greetings = await getGreetingsByCategory(categoryId);
      } catch (catErr) {
        console.error('[handler] getGreetingsByCategory error:', catErr.message);
        await sendText(phoneNumberId, phone, 'שגיאה בטעינת ברכות. נסה שוב.');
        return;
      }
      console.log(`[handler] greetings count=${greetings.length}`);
      if (greetings.length === 0) {
        await sendText(phoneNumberId, phone, `לא נמצאו ברכות לקטגוריה "${selectedTitle}".`);
        return;
      }
      console.log(`[handler] sending carousel for category ${categoryId}`);
      try {
        await sendGreetingCarousel(phoneNumberId, phone, selectedTitle, greetings);
        console.log(`[handler] carousel sent OK`);
      } catch (carouselErr) {
        console.warn('[handler] Carousel failed, falling back to list:', carouselErr.message);
        await sendGreetingList(phoneNumberId, phone, selectedTitle, greetings);
        console.log(`[handler] list sent OK`);
      }
      return;
    }

    // בחירת ברכה → פתיחת Flow
    if (selectedId.startsWith('choose_greeting_')) {
      console.log(`[handler] greeting selected: ${selectedId}`);
      const greetingId = selectedId.replace('choose_greeting_', '');
      console.log(`[handler] fetching greeting id=${greetingId}`);
      const greeting = await getGreetingById(greetingId);
      console.log(`[handler] greeting found=${!!greeting} fields=${greeting?.content?.length}`);

      if (!greeting || !greeting.content || greeting.content.length === 0) {
        await sendText(phoneNumberId, phone, 'שגיאה בטעינת פרטי הברכה. נסה שוב.');
        return;
      }

      try {
        const flowId = await getOrCreateFlow(greeting);
        await sendFlowMessage(phoneNumberId, phone, flowId, `מלא את הפרטים לברכה:`);
      } catch (err) {
        console.error('[handler] Flow creation failed, falling back to Q&A:', err.message, err.response?.data);
        setSession(phone, {
          greetingId: parseInt(greetingId),
          fields: greeting.content,
          currentFieldIndex: 0,
          collected: { phone },
          phoneNumberId,
        });
        const firstField = greeting.content[0];
        await sendText(
          phoneNumberId,
          phone,
          `בחרת ברכה! נמלא יחד את הפרטים.\n\nשלח "ביטול" בכל שלב לחזרה לתפריט.\n\n` +
          `(1/${greeting.content.length}) ${firstField.name}:`
        );
      }
      return;
    }
  }
}

/**
 * טיפול בקלט משתמש בזמן מילוי שדות (Q&A fallback)
 */
async function handleSessionInput(phone, phoneNumberId, session, text) {
  const { fields, currentFieldIndex, collected, greetingId } = session;

  const currentField = fields[currentFieldIndex];
  collected[currentField.param] = text;

  const nextIndex = currentFieldIndex + 1;

  if (nextIndex < fields.length) {
    setSession(phone, { ...session, currentFieldIndex: nextIndex, collected });
    const nextField = fields[nextIndex];
    await sendText(
      phoneNumberId,
      phone,
      `(${nextIndex + 1}/${fields.length}) ${nextField.name}:`
    );
    return;
  }

  console.log(`[handler] all fields collected, calling create API. greetingId=${greetingId}`);
  deleteSession(phone);
  await createEcard(phoneNumberId, phone, greetingId, collected);
}

/**
 * יצירת ברכה דרך ה-API ושליחת הקישור למשתמש
 */
async function createEcard(phoneNumberId, phone, greetingId, fields) {
  await sendText(phoneNumberId, phone, 'מעבד את הברכה... ⏳');

  try {
    const body = {
      post_id: greetingId,
      ...fields,
      generate_pdf: true,
    };

    console.log('Creating ecard:', JSON.stringify(body));

    const { data } = await axios.post(
      `${process.env.CATALOG_BASE_URL}/create`,
      body,
      { headers: { 'X-ECARD-API-KEY': process.env.CATALOG_API_KEY } }
    );

    console.log('Create response:', JSON.stringify(data));

    const fileUrl =
      data.image_url || data.url || data.pdf_url || data.file_url || data.download_url || data.link || data.data?.image_url || data.data?.url || data.result?.image_url || data.result?.url;

    if (fileUrl) {
      if (isImageUrl(fileUrl)) {
        try {
          await sendImage(phoneNumberId, phone, fileUrl, '✅ הברכה שלך מוכנה!');
        } catch (imgErr) {
          console.warn('sendImage failed, sending link instead:', imgErr.message);
          await sendText(phoneNumberId, phone, `✅ הברכה שלך מוכנה!\n\n${fileUrl}`);
        }
      } else {
        await sendText(phoneNumberId, phone, `✅ הברכה שלך מוכנה!\n\n${fileUrl}`);
      }
    } else {
      await sendText(
        phoneNumberId,
        phone,
        `✅ הברכה נוצרה!\n\n${JSON.stringify(data, null, 2).slice(0, 1000)}`
      );
    }
  } catch (err) {
    console.error('Create error:', err.message, err.response?.data);
    await sendText(phoneNumberId, phone, '❌ אירעה שגיאה ביצירת הברכה. נסה שוב מאוחר יותר.');
  }
}

module.exports = { handleMessage };
