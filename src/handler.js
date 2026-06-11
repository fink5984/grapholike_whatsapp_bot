const { getCategories, getGreetingsByCategory } = require('./catalog');
const { sendText, sendCategoryList, sendGreetingCarousel } = require('./whatsapp');

/**
 * עיבוד הודעה נכנסת מ-WhatsApp
 */
async function handleMessage(message, contact) {
  const phone = message.from;
  const name = contact?.profile?.name || 'לקוח';
  const type = message.type;

  // הודעת טקסט - מתחיל את הזרימה מהתחלה
  if (type === 'text') {
    const categories = await getCategories();
    if (categories.length === 0) {
      await sendText(phone, 'מצטערים, לא נמצאו קטגוריות כרגע. נסה שוב מאוחר יותר.');
      return;
    }
    await sendCategoryList(phone, name, categories);
    return;
  }

  // תגובה אינטראקטיבית
  if (type === 'interactive') {
    const interactiveType = message.interactive?.type;
    let selectedId = '';
    let selectedTitle = '';

    if (interactiveType === 'list_reply') {
      selectedId = message.interactive.list_reply?.id || '';
      selectedTitle = message.interactive.list_reply?.title || '';
    } else if (interactiveType === 'button_reply') {
      selectedId = message.interactive.button_reply?.id || '';
      selectedTitle = message.interactive.button_reply?.title || '';
    }

    // בחירת קטגוריה → מציג קרוסלה של ברכות
    if (selectedId.startsWith('cat_')) {
      const categoryId = selectedId.replace('cat_', '');
      const greetings = await getGreetingsByCategory(categoryId);
      if (greetings.length === 0) {
        await sendText(phone, `לא נמצאו ברכות לקטגוריה "${selectedTitle}".`);
        return;
      }
      await sendGreetingCarousel(phone, selectedTitle, greetings);
      return;
    }

    // בחירת ברכה ספציפית
    if (selectedId.startsWith('choose_greeting_')) {
      const greetingId = selectedId.replace('choose_greeting_', '');
      await sendText(phone, `בחרת ברכה מספר ${greetingId}!\n\nאנא שלח את שם המקבל/ת:`);
      return;
    }
  }
}

module.exports = { handleMessage };
