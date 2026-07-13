// רינדור דף התשלום (שלב 9) — דף HTML עצמאי עם אייפרם נדרים פלוס.
//
// התקשורת עם האייפרם נעשית ב-PostMessage לפי התיעוד של נדרים:
// הדף טוען את האייפרם, מבקש ממנו את הגובה (GetHeight), ובלחיצה על "תשלום"
// שולח לו את כל פרטי העסקה (FinishTransaction2). פרטי האשראי עצמם מוזנים
// בתוך האייפרם ולא עוברים דרך השרת שלנו.
//
// שים לב: PostMessage לא עובד ב-localhost — חובה דומיין אמיתי (PUBLIC_BASE_URL).

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// הזרקה בטוחה של אובייקט JS לתוך <script>
function toJsLiteral(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

// טלפון וואטסאפ מגיע בפורמט בינלאומי (9725...) — נדרים מצפים לפורמט מקומי
function toLocalPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('972')) return '0' + digits.slice(3);
  return digits;
}

const BASE_STYLE = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', 'Heebo', Arial, sans-serif;
    background: linear-gradient(160deg, #2d1b4e 0%, #4a2a6a 55%, #6b3fa0 100%);
    min-height: 100vh;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 24px 12px 48px;
    color: #2b2b3c;
  }
  .card {
    background: #ffffff;
    border-radius: 20px;
    box-shadow: 0 18px 50px rgba(20, 8, 40, 0.45);
    width: 100%;
    max-width: 480px;
    overflow: hidden;
  }
  .card-header {
    background: linear-gradient(135deg, #3b2063, #6b3fa0);
    color: #fff;
    text-align: center;
    padding: 26px 20px 22px;
  }
  .brand {
    font-size: 15px;
    letter-spacing: 2px;
    opacity: 0.85;
    text-transform: uppercase;
  }
  .card-header h1 { font-size: 24px; margin-top: 6px; font-weight: 700; }
  .card-body { padding: 22px 22px 28px; }
  .summary {
    display: flex;
    align-items: center;
    gap: 14px;
    background: #f7f4fc;
    border: 1px solid #e6ddf5;
    border-radius: 14px;
    padding: 14px;
    margin-bottom: 18px;
  }
  .summary img {
    width: 74px;
    height: 74px;
    object-fit: cover;
    border-radius: 10px;
    flex-shrink: 0;
    border: 1px solid #e0d5f0;
  }
  .summary .info { flex: 1; }
  .summary .title { font-weight: 700; font-size: 16px; color: #3b2063; }
  .summary .sub { font-size: 13px; color: #7a7291; margin-top: 3px; }
  .amount-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    border-top: 1px dashed #d9cdec;
    margin-top: 10px;
    padding-top: 10px;
  }
  .amount-row .label { font-size: 14px; color: #7a7291; }
  .amount-row .amount { font-size: 26px; font-weight: 800; color: #3b2063; }
  .section-title {
    font-size: 15px;
    font-weight: 700;
    color: #3b2063;
    margin: 4px 2px 10px;
  }
  #NedarimFrame { width: 100%; border: none; height: 0; }
  .frame-wrap {
    border: 1px solid #e6ddf5;
    border-radius: 14px;
    overflow: hidden;
    background: #fff;
    min-height: 120px;
    position: relative;
  }
  .frame-loading {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #7a7291;
    font-size: 14px;
    background: #faf8fe;
  }
  .pay-btn {
    display: block;
    width: 100%;
    margin-top: 18px;
    padding: 15px;
    border: none;
    border-radius: 14px;
    background: linear-gradient(135deg, #6b3fa0, #8a5cc9);
    color: #fff;
    font-size: 18px;
    font-weight: 700;
    cursor: pointer;
    transition: opacity 0.2s, transform 0.1s;
  }
  .pay-btn:active { transform: scale(0.985); }
  .pay-btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .error-box {
    display: none;
    margin-top: 14px;
    background: #fdeeee;
    border: 1px solid #f3c2c2;
    color: #a33030;
    border-radius: 12px;
    padding: 12px 14px;
    font-size: 14px;
    text-align: center;
  }
  .secure-note {
    margin-top: 16px;
    text-align: center;
    font-size: 12.5px;
    color: #8f87a5;
  }
  .browser-banner {
    display: none;
    align-items: center;
    gap: 10px;
    background: #fff8e6;
    border: 1px solid #f0dfae;
    border-radius: 12px;
    padding: 11px 14px;
    margin-bottom: 16px;
    font-size: 13.5px;
    color: #7a6320;
    line-height: 1.45;
  }
  .browser-banner .open-btn {
    flex-shrink: 0;
    border: none;
    border-radius: 9px;
    background: #6b3fa0;
    color: #fff;
    font-size: 13px;
    font-weight: 700;
    padding: 9px 14px;
    cursor: pointer;
    white-space: nowrap;
  }
  .status-card { text-align: center; padding: 44px 26px 40px; }
  .status-icon { font-size: 58px; line-height: 1; }
  .status-card h2 { font-size: 23px; color: #3b2063; margin: 16px 0 10px; }
  .status-card p { font-size: 15.5px; color: #6a6280; line-height: 1.6; }
  .hidden { display: none !important; }
`;

/**
 * דף סטטוס פשוט (קישור לא תקף / פג תוקף / כבר שולם).
 */
function renderStatusPage({ icon, title, body }) {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GraphoLike — תשלום</title>
<style>${BASE_STYLE}</style>
</head>
<body>
  <div class="card">
    <div class="card-header">
      <div class="brand">GraphoLike</div>
      <h1>תשלום מאובטח</h1>
    </div>
    <div class="status-card">
      <div class="status-icon">${icon}</div>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(body)}</p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * דף התשלום המלא.
 * payment — רשומת תשלום מ-payments.js
 * mosadId / apiValid — פרטי המוסד בנדרים פלוס
 * callbackUrl — כתובת ה-CallBack בשרת שלנו (גיבוי לאישור מצד הלקוח)
 */
function renderPaymentPage({ payment, mosadId, apiValid, callbackUrl, confirmUrl }) {
  const customer = payment.customer || {};
  const fullName = String(customer.name || '').trim();
  const firstName = fullName.split(/\s+/)[0] || '';
  const lastName = fullName.split(/\s+/).slice(1).join(' ');

  const cfg = {
    mosadId: String(mosadId),
    apiValid: String(apiValid),
    amount: String(payment.amount),
    token: payment.token,
    confirmUrl,
    callbackUrl,
    firstName,
    lastName,
    phone: toLocalPhone(customer.phone || payment.phone),
    email: String(customer.email || ''),
    comment: `GraphoLike הזמנה ${payment.greetingId}`,
  };

  const imageHtml = payment.image
    ? `<img src="${escapeHtml(payment.image)}" alt="העיצוב שנבחר">`
    : '';

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GraphoLike — תשלום מאובטח</title>
<style>${BASE_STYLE}</style>
</head>
<body>
  <div class="card">
    <div class="card-header">
      <div class="brand">GraphoLike</div>
      <h1>💳 תשלום מאובטח</h1>
    </div>

    <!-- מסך תשלום -->
    <div class="card-body" id="payment-view">
      <!-- מוצג רק בתוך דפדפן פנימי (וואטסאפ וכד') — שם המילוי האוטומטי
           של כרטיסים שמורים לא זמין -->
      <div class="browser-banner" id="browser-banner">
        <span>💡 לתשלום מהיר עם כרטיס שמור בטלפון, מומלץ לפתוח את הדף בדפדפן.</span>
        <button class="open-btn" id="open-browser-btn" type="button">פתיחה בדפדפן</button>
      </div>
      <div class="summary">
        ${imageHtml}
        <div class="info">
          <div class="title">עיצוב הזמנה מותאם אישית</div>
          <div class="sub">${escapeHtml(fullName ? `עבור ${fullName}` : 'ההזמנה שלכם')}</div>
          <div class="amount-row">
            <span class="label">סה"כ לתשלום</span>
            <span class="amount">₪${escapeHtml(payment.amount)}</span>
          </div>
        </div>
      </div>

      <div class="section-title">פרטי כרטיס אשראי</div>
      <div class="frame-wrap">
        <div class="frame-loading" id="frame-loading">טוען טופס תשלום מאובטח...</div>
        <iframe id="NedarimFrame" scrolling="no"></iframe>
      </div>

      <button class="pay-btn" id="pay-btn" disabled>לתשלום ₪${escapeHtml(payment.amount)}</button>
      <div class="error-box" id="error-box"></div>
      <div class="secure-note">🔒 התשלום מאובטח ומבוצע באמצעות נדרים פלוס.<br>פרטי הכרטיס אינם נשמרים אצלנו.</div>
    </div>

    <!-- מסך הצלחה -->
    <div class="status-card hidden" id="success-view">
      <div class="status-icon">🎉</div>
      <h2>התשלום בוצע בהצלחה!</h2>
      <p>העסקה אושרה והעיצוב שלכם נכנס לעבודה.<br>
      חזרו לוואטסאפ — ההזמנה המוכנה תישלח אליכם שם בעוד רגע 💬</p>
    </div>
  </div>

<script>
  var CFG = ${toJsLiteral(cfg)};

  var frame = document.getElementById('NedarimFrame');
  var payBtn = document.getElementById('pay-btn');
  var errorBox = document.getElementById('error-box');
  var frameLoading = document.getElementById('frame-loading');
  var finished = false;

  // זיהוי דפדפן פנימי (WebView של וואטסאפ ודומיו) — שם ההשלמה האוטומטית של
  // כרטיסים שמורים לא עובדת, אז מציעים לפתוח בדפדפן האמיתי.
  (function () {
    var ua = navigator.userAgent || '';
    var isAndroidWebView = /Android/i.test(ua) && (/\bwv\b/.test(ua) || /Version\/\d/.test(ua) || /WhatsApp/i.test(ua));
    var isIosInApp = /iPhone|iPad|iPod/i.test(ua) && (!/Safari\//i.test(ua) || /WhatsApp/i.test(ua));
    if (!isAndroidWebView && !isIosInApp) return;

    var banner = document.getElementById('browser-banner');
    banner.style.display = 'flex';

    document.getElementById('open-browser-btn').addEventListener('click', function () {
      var url = window.location.href;
      if (isAndroidWebView) {
        // intent:// פותח את הדפדפן שמוגדר כברירת מחדל באנדרואיד
        window.location.href =
          'intent://' + window.location.host + window.location.pathname + window.location.search +
          '#Intent;scheme=https;end';
      } else {
        // iOS — ניסיון לפתוח בספארי; אם נכשל, מעתיקים את הקישור
        window.location.href = 'x-safari-' + url;
      }
      setTimeout(function () {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(function () {
            alert('הקישור הועתק — הדביקו אותו בדפדפן');
          }).catch(function () {});
        }
      }, 1500);
    });
  })();

  // רישום המאזין וטעינת ה-src פעם אחת בלבד בחיי הדף (לפי אזהרת התיעוד —
  // רישום כפול גורם לטיפול כפול ב-TransactionResponse ולחיוב כפול).
  window.addEventListener('message', ReadPostMessage);

  // GetHeight בפולינג עד לתשובה הראשונה: שליחה חד-פעמית ב-onload הולכת
  // לאיבוד אם הסקריפט בתוך האייפרם עוד לא נטען (קורה ברשת איטית / WebView
  // של וואטסאפ) — והטופס נתקע על "טוען...".
  var heightReceived = false;
  var heightPoll = null;

  function startHeightPolling() {
    if (heightPoll) return;
    heightPoll = setInterval(function () {
      if (heightReceived) { clearInterval(heightPoll); return; }
      PostNedarim({ Name: 'GetHeight' });
    }, 500);

    // אחרי 12 שניות בלי תשובה — משחררים את הטופס עם גובה ברירת מחדל,
    // כדי שהלקוח לא יישאר תקוע מול "טוען..."
    setTimeout(function () {
      if (heightReceived) return;
      frame.style.height = '520px';
      frameLoading.style.display = 'none';
      if (!finished) payBtn.disabled = false;
    }, 12000);
  }

  frame.onload = startHeightPolling;
  frame.src = 'https://www.matara.pro/nedarimplus/iframe/';
  startHeightPolling();

  // שמירה על רספונסיביות — בכל שינוי גודל חלון מבקשים את הגובה מחדש
  window.addEventListener('resize', function () {
    PostNedarim({ Name: 'GetHeight' });
  });

  function PostNedarim(data) {
    frame.contentWindow.postMessage(data, '*');
  }

  function ReadPostMessage(event) {
    switch (event.data.Name) {
      case 'Height':
        heightReceived = true;
        frame.style.height = (parseInt(event.data.Value) + 15) + 'px';
        frameLoading.style.display = 'none';
        if (!finished) payBtn.disabled = false;
        break;

      case 'TransactionResponse':
        console.log('TransactionResponse', event.data.Value);
        if (event.data.Value && event.data.Value.Status === 'Error') {
          showError(event.data.Value.Message || 'אירעה שגיאה בביצוע התשלום. נסו שוב.');
          setPaying(false);
        } else {
          onSuccess(event.data.Value || {});
        }
        break;
    }
  }

  // נעילת הכפתור מרגע שליחת העסקה ועד קבלת תשובה — מניעת חיוב כפול
  function setPaying(paying) {
    payBtn.disabled = paying;
    payBtn.textContent = paying ? 'מבצע תשלום...' : 'לתשלום ₪' + CFG.amount;
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.style.display = 'block';
  }

  payBtn.addEventListener('click', function () {
    if (finished) return;
    errorBox.style.display = 'none';
    setPaying(true);

    PostNedarim({
      Name: 'FinishTransaction2',
      Value: {
        Mosad: CFG.mosadId,
        ApiValid: CFG.apiValid,
        PaymentType: 'Ragil',
        Currency: '1',

        Zeout: '',
        FirstName: CFG.firstName,
        LastName: CFG.lastName,
        Street: '',
        City: '',
        Phone: CFG.phone,
        Mail: CFG.email,

        Amount: CFG.amount,
        Tashlumim: '1',

        Groupe: '',
        Comment: CFG.comment,
        Param1: CFG.token,
        Param2: '',
        ForceUpdateMatching: '',

        CallBack: CFG.callbackUrl,
        CallBackMailError: ''
      }
    });
  });

  function onSuccess(transaction) {
    if (finished) return;
    finished = true;

    // עדכון השרת מצד הלקוח; ה-CallBack של נדרים לשרת משמש כגיבוי,
    // כך שגם אם הבקשה הזו נכשלת — הבוט יקבל את אישור התשלום.
    try {
      fetch(CFG.confirmUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction: transaction }),
        keepalive: true
      }).catch(function () {});
    } catch (e) { /* ignore */ }

    document.getElementById('payment-view').classList.add('hidden');
    document.getElementById('success-view').classList.remove('hidden');
    window.scrollTo(0, 0);
  }
</script>
</body>
</html>`;
}

module.exports = { renderPaymentPage, renderStatusPage };
