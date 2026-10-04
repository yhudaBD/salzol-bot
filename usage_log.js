/**
 * usage_log.js  -  שלב 4: יומן שימוש ושגיאות ב-Google Sheets (רץ רק ב-Apps Script)
 *
 * הגיליון נוצר אוטומטית בפעם הראשונה (בחשבון של הבוט), והמזהה שלו נשמר
 * ב-Script Properties בשם LOG_SHEET_ID. הקישור מודפס ביומן הביצוע של setup.
 *
 * לשוניות:
 *   בקשות  - שורה לכל בקשה (סעיף 8.1 באפיון)
 *   שגיאות - תאריך, סוג, פירוט, רשת
 *   סיכום  - מתעדכן כל לילה ע"י updateSummary (אפשר גם להריץ ידנית)
 *
 * פרטיות: נשמר רק מזהה מוצפן של המשתמש, אף פעם לא כתובת המייל.
 */

var LOG_SHEETS = {
  requests: "בקשות",
  errors: "שגיאות",
  summary: "סיכום"
};

var REQUEST_COLUMNS = [
  "תאריך ושעה", "מזהה משתמש", "ערוץ", "עיר", "סוג בקשה", "טקסט חיפוש", "נמצא",
  "מספר מוצרים", "מוצרים שנמצאו", "לא נמצאו", "רשת זולה ביותר", "גרסת נתונים", "זמן תגובה (ms)"
];
var ERROR_COLUMNS = ["תאריך ושעה", "סוג שגיאה", "פירוט", "רשת"];

var KIND_NAMES = { product: "מוצר בודד", basket: "סל", help: "עזרה", limit: "חריגה ממגבלה" };
var FOUND_NAMES = { yes: "כן", no: "לא", partial: "חלקי" };

// ---------------------------------------------------------------------------
// גישה לגיליון
// ---------------------------------------------------------------------------
function getLogSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty("LOG_SHEET_ID");
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) { /* נמחק? ניצור חדש */ }
  }
  var ss = SpreadsheetApp.create("סלזול בוט - יומן שימוש");
  ss.setSpreadsheetLocale("iw_IL");
  ss.setSpreadsheetTimeZone("Asia/Jerusalem");
  var first = ss.getSheets()[0];
  first.setName(LOG_SHEETS.requests);
  prepareSheet_(first, REQUEST_COLUMNS);
  prepareSheet_(ss.insertSheet(LOG_SHEETS.errors), ERROR_COLUMNS);
  ss.insertSheet(LOG_SHEETS.summary).setRightToLeft(true);
  props.setProperty("LOG_SHEET_ID", ss.getId());
  return ss;
}

function prepareSheet_(sheet, columns) {
  sheet.setRightToLeft(true);
  sheet.getRange(1, 1, 1, columns.length).setValues([columns]).setFontWeight("bold").setBackground("#e8f0fe");
  sheet.setFrozenRows(1);
}

function getSheet_(name) {
  var ss = getLogSpreadsheet_();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

// ---------------------------------------------------------------------------
// רישום
// ---------------------------------------------------------------------------
/**
 * entry: {user, channel, city, reply, query, version, ms}
 * reply הוא מה ש-handleMessage מחזיר, או {kind: "limit"}.
 */
function logRequest(entry) {
  try {
    var r = entry.reply || {};
    getSheet_(LOG_SHEETS.requests).appendRow([
      new Date(),
      entry.user,
      entry.channel,
      entry.city || "כל הארץ",
      KIND_NAMES[r.kind] || r.kind || "",
      String(entry.query || "").slice(0, 200),
      FOUND_NAMES[r.found] || "",
      r.kind === "basket" ? r.items : (r.kind === "product" ? 1 : 0),
      (r.matched || []).join(" | "),
      (r.notFound || []).join(" | "),
      r.cheapest ? chainName(r.cheapest) : "",
      entry.version || "",
      entry.ms
    ]);
  } catch (e) {
    // היומן אף פעם לא מפיל את הבוט. רושמים ב-Logger ומתקדמים.
    Logger.log("logRequest נכשל: " + e);
  }
}

function logError(type, details, chain) {
  Logger.log("ERROR " + type + ": " + details);
  try {
    getSheet_(LOG_SHEETS.errors).appendRow([new Date(), type, String(details).slice(0, 1000), chain || ""]);
  } catch (e) {
    Logger.log("logError נכשל: " + e);
  }
}

// ---------------------------------------------------------------------------
// סיכום (רץ כל לילה, ואפשר גם ידנית מהעורך)
// ---------------------------------------------------------------------------
function updateSummary() {
  var ss = getLogSpreadsheet_();
  var rows = ss.getSheetByName(LOG_SHEETS.requests).getDataRange().getValues().slice(1);
  var errors = ss.getSheetByName(LOG_SHEETS.errors).getDataRange().getValues().slice(1);
  var out = [];

  // --- כללי
  var users = {};
  rows.forEach(function (r) { users[r[1]] = true; });
  var last = rows.length ? rows[rows.length - 1][0] : "";
  out.push(["כללי"]);
  out.push(["סה\"כ בקשות", rows.length]);
  out.push(["משתמשים ייחודיים (מאז ההתחלה)", Object.keys(users).length]);
  out.push(["בקשה אחרונה", last ? Utilities.formatDate(new Date(last), "Asia/Jerusalem", "dd.MM.yyyy HH:mm") : "אין עדיין"]);
  out.push(["שגיאות ב-7 הימים האחרונים", errors.filter(function (e) { return daysAgo_(e[0]) <= 7; }).length]);
  out.push([""]);

  // --- לפי שבוע: משתמשים, בקשות למשתמש, אחוז חזרה בשבוע הבא
  var weeks = {};
  rows.forEach(function (r) {
    var w = weekStart_(r[0]);
    weeks[w] = weeks[w] || { users: {}, requests: 0 };
    weeks[w].users[r[1]] = true;
    weeks[w].requests++;
  });
  var weekKeys = Object.keys(weeks).sort();
  out.push(["לפי שבוע (מתחיל ביום ראשון)", "משתמשים ייחודיים", "בקשות למשתמש", "חזרו בשבוע הבא"]);
  weekKeys.forEach(function (w, i) {
    var u = Object.keys(weeks[w].users);
    var next = weekKeys[i + 1] === nextWeek_(w) ? weeks[weekKeys[i + 1]].users : null;
    var back = next ? u.filter(function (x) { return next[x]; }).length : null;
    out.push([w, u.length, round1_(weeks[w].requests / u.length),
              back === null ? "-" : Math.round(100 * back / u.length) + "%"]);
  });
  out.push([""]);

  // --- 20 החיפושים הנפוצים שלא נמצאו
  out.push(["20 החיפושים הנפוצים שלא נמצאו", "כמה פעמים"]);
  top_(rows, 9, 20).forEach(function (x) { out.push(x); });
  out.push([""]);

  // --- 20 המוצרים הנפוצים
  out.push(["20 המוצרים הנפוצים", "כמה פעמים"]);
  top_(rows, 8, 20).forEach(function (x) { out.push(x); });
  out.push([""]);

  // --- פילוח לפי ערוץ, עיר וסוג בקשה
  [[2, "לפי ערוץ"], [3, "לפי עיר"], [4, "לפי סוג בקשה"]].forEach(function (c) {
    out.push([c[1], "בקשות"]);
    top_(rows, c[0], 50).forEach(function (x) { out.push(x); });
    out.push([""]);
  });

  out.push(["עודכן", Utilities.formatDate(new Date(), "Asia/Jerusalem", "dd.MM.yyyy HH:mm")]);

  var sheet = ss.getSheetByName(LOG_SHEETS.summary) || ss.insertSheet(LOG_SHEETS.summary);
  sheet.clear();
  sheet.setRightToLeft(true);
  var width = 4;
  var grid = out.map(function (r) { while (r.length < width) r.push(""); return r; });
  sheet.getRange(1, 1, grid.length, width).setValues(grid);
  grid.forEach(function (r, i) {               // כותרות של כל טבלה מודגשות
    if (r[0] && (i === 0 || grid[i - 1][0] === "")) sheet.getRange(i + 1, 1, 1, width).setFontWeight("bold");
  });
  sheet.autoResizeColumns(1, width);
}

// סופר ערכים בעמודה (גם רשימות מופרדות ב-" | ") ומחזיר את ה-n הנפוצים
function top_(rows, col, n) {
  var counts = {};
  rows.forEach(function (r) {
    String(r[col] || "").split(" | ").forEach(function (v) {
      v = v.trim();
      if (v) counts[v] = (counts[v] || 0) + 1;
    });
  });
  return Object.keys(counts).map(function (k) { return [k, counts[k]]; })
               .sort(function (a, b) { return b[1] - a[1]; }).slice(0, n);
}

function weekStart_(d) {
  var date = new Date(d);
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - date.getDay());   // יום ראשון
  return Utilities.formatDate(date, "Asia/Jerusalem", "yyyy-MM-dd");
}

function nextWeek_(w) {
  var d = new Date(w + "T12:00:00");
  d.setDate(d.getDate() + 7);
  return Utilities.formatDate(d, "Asia/Jerusalem", "yyyy-MM-dd");
}

function daysAgo_(d) { return (Date.now() - new Date(d).getTime()) / 86400000; }
function round1_(x) { return Math.round(x * 10) / 10; }
