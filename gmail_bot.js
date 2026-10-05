/**
 * gmail_bot.js  -  שלב 3: סלזול בוט במייל (רץ רק ב-Google Apps Script)
 *
 * בפרויקט Apps Script צריכים להיות 4 קבצים: search, bot_core, usage_log, gmail_bot.
 * הוראות התקנה: SETUP.md
 *
 * מה קורה בכל הרצה (כל 5 דקות):
 *   1. מחפש מיילים חדשים שלא נקראו בתיבה.
 *   2. אם אין - יוצא מיד (חוסך מכסה).
 *   3. טוען את קובץ המחירים, ועונה לכל מייל.
 *   4. מסמן את המייל כנקרא ומוסיף תווית "salzol/done" (או "salzol/error").
 */

var CONFIG = {
  DAILY_LIMIT_PER_SENDER: 20,     // הגבלת קצב: בקשות ליום לכל כתובת
  MAX_THREADS_PER_RUN: 20,        // כדי לא לחרוג מזמן הריצה של Apps Script
  TRIGGER_MINUTES: 5
};

// כתובות שלא עונים להן אף פעם (מניעת לולאות עם בוטים ומערכות דיוור)
var IGNORE_SENDERS = /(mailer-daemon|postmaster|no-?reply|noreply|notifications?@|bounce)/i;

// ---------------------------------------------------------------------------
// התקנה (מריצים פעם אחת ידנית מתוך עורך Apps Script)
// ---------------------------------------------------------------------------
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === "processInbox" || fn === "updateSummary") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("processInbox").timeBased().everyMinutes(CONFIG.TRIGGER_MINUTES).create();
  ScriptApp.newTrigger("updateSummary").timeBased().everyDays(1).atHour(2).create();  // סיכום היומן כל לילה
  getLabel_("salzol/done");
  getLabel_("salzol/error");
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty("HASH_SALT")) props.setProperty("HASH_SALT", Utilities.getUuid());
  var log = getLogSpreadsheet_();
  Logger.log("ההתקנה הסתיימה. הבוט יבדוק את התיבה כל %s דקות.", CONFIG.TRIGGER_MINUTES);
  Logger.log("מקור המחירים: %s", describePricesSource_());
  Logger.log("יומן השימוש: %s", log.getUrl());
}

// בדיקה ידנית בלי מייל: משנים את הטקסט ומריצים מהעורך
function testReply() {
  var data = loadPrices_();
  var index = buildIndex(data.items);
  var reply = handleMessage("סל: חלב, ביצים L, לחם, שמן", data, index);
  Logger.log(reply.text);
}

// ---------------------------------------------------------------------------
// הריצה הקבועה
// ---------------------------------------------------------------------------
function processInbox() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;            // הרצה קודמת עדיין פועלת
  try {
    var me = Session.getEffectiveUser().getEmail().toLowerCase();
    var threads = GmailApp.search("in:inbox is:unread -label:salzol-done", 0, CONFIG.MAX_THREADS_PER_RUN);
    if (!threads.length) return;

    var data = loadPrices_();
    var index = buildIndex(data.items);
    var done = getLabel_("salzol/done"), failed = getLabel_("salzol/error");

    threads.forEach(function (thread) {
      var messages = thread.getMessages();
      var msg = null;
      for (var i = messages.length - 1; i >= 0; i--) {     // ההודעה האחרונה שלא נקראה ולא נשלחה ממני
        if (messages[i].isUnread() && fromAddress_(messages[i]) !== me) { msg = messages[i]; break; }
      }
      if (!msg) { thread.markRead(); return; }

      try {
        handleEmail_(msg, data, index);
        thread.addLabel(done);
      } catch (e) {
        thread.addLabel(failed);
        logError_("reply_failed", String(e && e.stack || e));
      }
      thread.markRead();
    });
  } finally {
    lock.releaseLock();
  }
}

function handleEmail_(msg, data, index) {
  var from = fromAddress_(msg);
  if (IGNORE_SENDERS.test(from)) return;

  if (MailApp.getRemainingDailyQuota() < 1) {
    throw new Error("נגמרה מכסת השליחה היומית של Gmail");
  }

  var started = Date.now();
  var userId = hashSender_(from);

  // טקסט הבקשה: גוף המייל, ואם הוא ריק - הנושא
  var text = cleanEmailBody(msg.getPlainBody());
  if (!text) text = String(msg.getSubject() || "").replace(/^(re|fwd?|תשובה)\s*:\s*/i, "").trim();

  var reply;
  var city = getUserCity_(userId);
  if (!allowRequest_(userId)) {
    reply = { kind: "limit" };
    msg.reply("הגעתם למגבלה של " + CONFIG.DAILY_LIMIT_PER_SENDER +
              " בקשות ביום. אפשר לנסות שוב מחר. תודה! " + BOT_NAME);
  } else {
    reply = handleMessage(text, data, index, city);
    if (reply.setCity !== undefined) {
      setUserCity_(userId, reply.setCity);
      city = reply.setCity;
    }
    msg.reply(reply.text, { htmlBody: reply.html, name: BOT_NAME });
  }

  logRequest({ user: userId, channel: "מייל", city: city, reply: reply, query: text,
               version: data.updated, ms: Date.now() - started });
}

// ---------------------------------------------------------------------------
// קובץ המחירים
// ---------------------------------------------------------------------------
// מקור הקובץ נקבע ב-Script Properties (בעורך: Project Settings > Script Properties):
//   PRICES_URL      - כתובת ציבורית ל-prices.json (למשל GitHub Pages), או
//   PRICES_FILE_ID  - מזהה של קובץ prices.json ב-Google Drive של חשבון הבוט
function loadPrices_() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty("PRICES_URL");
  var fileId = props.getProperty("PRICES_FILE_ID");
  if (fileId) {                        // מקבל גם קישור מלא של Drive, ולא רק את המזהה
    var m = fileId.match(/\/d\/([\w-]+)|d\/([\w-]+)|[?&]id=([\w-]+)/);
    fileId = (m ? (m[1] || m[2] || m[3]) : fileId).trim();
  }
  var text;
  if (url) {
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      logError_("prices_fetch", "HTTP " + resp.getResponseCode() + " " + url);
      throw new Error("טעינת קובץ המחירים נכשלה");
    }
    text = resp.getContentText("UTF-8");
  } else if (fileId) {
    text = DriveApp.getFileById(fileId).getBlob().getDataAsString("UTF-8");
  } else {
    throw new Error("לא הוגדר מקור מחירים: חסר PRICES_URL או PRICES_FILE_ID ב-Script Properties");
  }
  var data = JSON.parse(text);
  var ageDays = (Date.now() - new Date(data.updated).getTime()) / 86400000;
  if (ageDays > 3) logError_("prices_stale", "קובץ המחירים מתאריך " + data.updated);
  return data;
}

function describePricesSource_() {
  var props = PropertiesService.getScriptProperties();
  return props.getProperty("PRICES_URL") || (props.getProperty("PRICES_FILE_ID") ? "Drive: " +
         props.getProperty("PRICES_FILE_ID") : "לא הוגדר! (ראו SETUP.md)");
}

// ---------------------------------------------------------------------------
// עזרים
// ---------------------------------------------------------------------------
function fromAddress_(msg) {
  var from = String(msg.getFrom() || "");
  var m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

// מזהה משתמש מוצפן: לא שומרים את כתובת המייל עצמה (סעיף 8.1 באפיון)
function hashSender_(email) {
  var salt = PropertiesService.getScriptProperties().getProperty("HASH_SALT") || "";
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + email);
  return bytes.slice(0, 8).map(function (b) { return ((b + 256) % 256).toString(16); })
              .map(function (h) { return h.length < 2 ? "0" + h : h; }).join("");
}

// הגבלת קצב יומית. המונים נשמרים לפי תאריך, ומונים של ימים קודמים נמחקים.
function allowRequest_(userId) {
  var props = PropertiesService.getScriptProperties();
  var today = Utilities.formatDate(new Date(), "Asia/Jerusalem", "yyyyMMdd");
  if (props.getProperty("RL_DAY") !== today) {
    var all = props.getProperties();
    Object.keys(all).forEach(function (k) { if (k.indexOf("RL_") === 0) props.deleteProperty(k); });
    props.setProperty("RL_DAY", today);
  }
  var key = "RL_" + userId;
  var count = parseInt(props.getProperty(key) || "0", 10) + 1;
  props.setProperty(key, String(count));
  return count <= CONFIG.DAILY_LIMIT_PER_SENDER;
}

// העיר של כל משתמש נשמרת לפי המזהה המוצפן, לא לפי הכתובת. "" = כל הארץ.
function getUserCity_(userId) {
  return PropertiesService.getScriptProperties().getProperty("CITY_" + userId) || "";
}

function setUserCity_(userId, city) {
  var props = PropertiesService.getScriptProperties();
  if (city) props.setProperty("CITY_" + userId, city);
  else props.deleteProperty("CITY_" + userId);
}

function getLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

// שגיאות: לגיליון "שגיאות" ביומן (usage_log)
function logError_(type, details) {
  logError(type, details, "");
}
