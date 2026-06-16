const axios = require('axios');
const { getCategories, getGreetingsByCategory, getGreetingById } = require('./catalog');
const { sendText, sendCategoryList, sendGreetingCarousel, sendGreetingList, markAsRead, sendTyping, sendFlowMessage } = require('./whatsapp');
const { getSession, setSession, deleteSession } = require('./sessions');
const { getOrCreateFlow } = require('./flows');

/**
 * עיבוד הודעה נכנסת מ-WhatsApp
 * phoneNumberId — נלקח מ-value.metadata.phone_number_id בתוך ה-webhook
 */
async function handleMessage(message, contact, phoneNumberId) {
  const phone = message.from;
  const name = contact?.profile?.name || 'לקוח';
  const type = message.type;

  console.log(`[handler] phone=${phone} type=${type} phoneNumberId=${phoneNumberId}`);

  // וי כחול — סימון קריאה
  await markAsRead(phoneNumberId, message.id);

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
    await sendTyping(phoneNumberId, phone);
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
      await sendTyping(phoneNumberId, phone);
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
      const { greeting_id, ...fields } = responseJson;
      console.log(`[handler] nfm_reply greetingId=${greeting_id} fields=${JSON.stringify(fields)}`);
      await createEcard(phoneNumberId, phone, parseInt(greeting_id), { ...fields, phone });
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
      const greetings = await getGreetingsByCategory(categoryId);
      if (greetings.length === 0) {
        await sendText(phoneNumberId, phone, `לא נמצאו ברכות לקטגוריה "${selectedTitle}".`);
        return;
      }
      await sendTyping(phoneNumberId, phone);
      try {
        await sendGreetingCarousel(phoneNumberId, phone, selectedTitle, greetings);
      } catch (carouselErr) {
        console.warn('[handler] Carousel failed, falling back to list:', carouselErr.message);
        await sendGreetingList(phoneNumberId, phone, selectedTitle, greetings);
      }
      return;
    }

    // בחירת ברכה → פתיחת Flow
    if (selectedId.startsWith('choose_greeting_')) {
      console.log(`[handler] greeting selected: ${selectedId}`);
      await sendTyping(phoneNumberId, phone);
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
  await sendTyping(phoneNumberId, phone);
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
      data.url || data.pdf_url || data.file_url || data.download_url || data.link;

    if (fileUrl) {
      await sendText(phoneNumberId, phone, `✅ הברכה שלך מוכנה!\n\n${fileUrl}`);
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
