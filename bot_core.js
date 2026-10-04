/**
 * bot_core.js  -  שלב 3: ההיגיון של סלזול בוט (בלי Gmail)
 *
 * מקבל טקסט של הודעה ומחזיר תשובה. רץ גם ב-Node (לבדיקות) וגם ב-Apps Script,
 * ולכן אין כאן שום קריאה ל-Gmail. החיבור ל-Gmail נמצא ב-gmail_bot.js.
 *
 * שימוש:
 *   var reply = handleMessage(text, data, index);
 *   // {kind, found, items, cheapest, text, html}
 */

var BOT_NAME = "סלזול בוט";
var CHAIN_NAMES = { rami_levy: "רמי לוי", shufersal: "שופרסל", yochananof: "יוחננוף",
                    osher_ad: "אושר עד", yesh_hesed: "יש חסד", victory: "ויקטורי",
                    kt_market: "KT מרקט" };
var CONFIDENT_SCORE = 0.85;   // מתחת לזה לא מנחשים, אלא מציעים אפשרויות
var RELATED_SCORE = 0.8;      // ציון מינימלי ל"אולי חיפשתם"
var MAX_BASKET_ITEMS = 20;

// ---------------------------------------------------------------------------
// ניקוי גוף המייל: בלי ציטוט של הודעות קודמות ובלי חתימה
// ---------------------------------------------------------------------------
function cleanEmailBody(body) {
  var lines = String(body || "").replace(/\r/g, "").split("\n");
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (/^(--|__)\s*$/.test(line)) break;                                  // חתימה
    if (/^(on .+wrote:|בתאריך .+כתב|ב-.+כתב.*:|-+ ?original message|-+ ?הודעה מקורית)/i.test(line)) break;
    if (/^(sent from|נשלח מ)/i.test(line)) break;
    if (line.charAt(0) === ">") continue;                                    // ציטוט
    out.push(line);
  }
  return out.join("\n").trim();
}

// ---------------------------------------------------------------------------
// הבנת הבקשה
// ---------------------------------------------------------------------------
/**
 * מחזיר {kind: "help"|"product"|"basket", lines: [{text, qty}]}
 * סל = כמה שורות, או פסיקים, או מתחיל ב"סל:".
 */
function parseRequest(text) {
  var t = String(text || "").trim();
  if (!t || /^(עזרה|help|\?|היי|שלום|הי)[\s!.?]*$/i.test(t)) return { kind: "help", lines: [] };

  var isBasket = /^סל\s*[:\-]/.test(t);
  t = t.replace(/^סל\s*[:\-]\s*/, "");
  var parts = t.split(/\n|,|،|;/).map(function (s) { return s.trim(); })
               .filter(function (s) { return s.length > 0; });
  if (parts.length > 1) isBasket = true;

  var lines = parts.slice(0, MAX_BASKET_ITEMS).map(parseQuantity);
  return { kind: isBasket ? "basket" : "product", lines: lines, truncated: parts.length > MAX_BASKET_ITEMS };
}

// "חלב x2", "2x חלב", "חלב * 3" -> כמות. מספר בלי x לא נחשב כמות ("חלב 3%").
function parseQuantity(s) {
  var m = s.match(/^(\d{1,2})\s*[x×*]\s*(.+)$/i) || null;
  if (m) return { text: m[2].trim(), qty: parseInt(m[1], 10) };
  m = s.match(/^(.+?)\s*[x×*]\s*(\d{1,2})$/i);
  if (m) return { text: m[1].trim(), qty: parseInt(m[2], 10) };
  return { text: s, qty: 1 };
}

// ---------------------------------------------------------------------------
// עיצוב
// ---------------------------------------------------------------------------
function chainName(c) { return CHAIN_NAMES[c] || c; }

function money(x) { return x.toFixed(2) + ' ש"ח'; }

function shortDate(iso) {             // "2026-10-04" -> "4.10"
  var p = String(iso || "").split("-");
  return p.length === 3 ? parseInt(p[2], 10) + "." + parseInt(p[1], 10) : iso;
}

function sortedPrices(prices) {
  return Object.keys(prices).map(function (c) { return { chain: c, price: prices[c] }; })
               .sort(function (a, b) { return a.price - b.price; });
}

function footer(data) {
  return "מחירים מעודכנים ל-" + shortDate(data.updated) +
         ". מחיר רגיל בסניפים הרגילים, בלי מבצעים.";
}

function helpText() {
  return [
    "שלום! אני " + BOT_NAME + ", ואני בודק איפה הכי זול.",
    "",
    "מוצר אחד: כתבו את שם המוצר, למשל:",
    "   חלב תנובה 3%",
    "",
    "סל קניות: כל מוצר בשורה נפרדת (או מופרדים בפסיקים), למשל:",
    "   חלב, ביצים L, לחם אחיד, שמן קנולה",
    "   כמות: ביצים L x2",
    "",
    "המחירים מגיעים מקבצי המחירים הרשמיים שהרשתות מפרסמות לפי חוק.",
    "לצורך שיפור השירות נאסף מידע סטטיסטי על החיפושים, בלי שמירת כתובת המייל."
  ].join("\n");
}

// ---------------------------------------------------------------------------
// בחירת המוצר להשוואה
// ---------------------------------------------------------------------------
// המוצר המרכזי לכל שורה הוא התוצאה הראשונה של החיפוש. ברשת שאין בה את אותו ברקוד
// (ביצים, לחם ומותגים פרטיים מקבלים ברקוד אחר בכל רשת) מחפשים מוצר דומה. תחליף חייב:
//   - להתאים לחיפוש (ציון של לפחות CONFIDENT_SCORE)
//   - להכיל את סוג המוצר (המילה הראשונה בשם המרכזי) באחת משלוש המילים הראשונות שלו
//     ("תבנית 12 ביצים" כן, "שמפו ביצים לשיער ..." לא)
//   - להיות במחיר דומה (פי 1.4 לכל כיוון), כדי שמארז חיסכון או מוצר אחר
//     ("אטריות ביצים" ב-7 ש"ח מול ביצים ב-14) לא ייחשבו תחליף
// ומביניהם: עדיפות למוצר עם אותם מספרים בשם (12 ביצים, 750 גרם, 3%), ואז לציון הגבוה.
var PRICE_RATIO = 1.4;
var CANDIDATES = 60;           // כמה תוצאות חיפוש לבדוק כשמחפשים תחליפים

function firstWord(name) { return tokenize(name)[0] || ""; }

function hasTypeWord(name, word) {
  return tokenize(name).slice(0, 3).indexOf(word) >= 0;
}

function numberTokens(name) {
  return tokenize(name).filter(function (t) { return /^\d/.test(t); });
}

function medianPrice(prices) {
  var v = Object.keys(prices).map(function (c) { return prices[c]; }).sort(function (a, b) { return a - b; });
  return v[v.length >> 1];
}

/**
 * מחזיר dict: רשת -> {price, name, same}. same=false כשזה מוצר דומה ולא אותו ברקוד.
 * רשת שאין בה שום דבר דומה לא מופיעה.
 */
function priceByChain(ref, results, chains) {
  var out = {};
  var refNums = numberTokens(ref.name);
  var refPrice = medianPrice(ref.prices);
  var refWord = firstWord(ref.name);
  chains.forEach(function (c) {
    if (ref.prices[c] !== undefined) {
      out[c] = { price: ref.prices[c], name: ref.name, same: true };
      return;
    }
    var best = null, bestKey = null;
    results.forEach(function (r) {
      var p = r.prices[c];
      if (p === undefined || r.score < CONFIDENT_SCORE || !hasTypeWord(r.name, refWord)) return;
      if (p > refPrice * PRICE_RATIO || p < refPrice / PRICE_RATIO) return;
      var nums = numberTokens(r.name);
      var shared = refNums.filter(function (n) { return nums.indexOf(n) >= 0; }).length;
      var key = [shared, r.score, -Math.abs(p - refPrice)];
      if (!bestKey || key[0] > bestKey[0] || (key[0] === bestKey[0] &&
          (key[1] > bestKey[1] + 0.001 || (Math.abs(key[1] - bestKey[1]) <= 0.001 && key[2] > bestKey[2])))) {
        best = r; bestKey = key;
      }
    });
    if (best) out[c] = { price: best.prices[c], name: best.name, same: false };
  });
  return out;
}

// ---------------------------------------------------------------------------
// טיפול בהודעה
// ---------------------------------------------------------------------------
function handleMessage(text, data, index) {
  var req = parseRequest(text);
  var res;
  if (req.kind === "help") {
    res = { kind: "help", found: "", matched: [], notFound: [], lines: [helpText()] };
  } else if (req.kind === "product") {
    res = productReply(req.lines[0].text, data, index);
  } else {
    res = basketReply(req, data, index);
  }
  res.text = res.lines.join("\n");
  res.html = toHtml(res.lines);
  return res;
}

function productReply(query, data, index) {
  var results = search(index, query, CANDIDATES);
  var lines = [];
  if (!results.length) {
    lines.push('לא מצאתי "' + query + '".');
    lines.push("נסו לכתוב את שם המוצר אחרת, או עם שם היצרן (למשל: חלב תנובה 3%).");
    return { kind: "product", found: "no", query: query, matched: [], notFound: [query], lines: lines };
  }

  var top = results[0];
  if (top.score < CONFIDENT_SCORE) {
    lines.push('לא מצאתי בדיוק את "' + query + '". התכוונתם ל:');
    results.slice(0, 3).forEach(function (r, i) {
      lines.push("   " + (i + 1) + ". " + r.name + " - " + money(sortedPrices(r.prices)[0].price));
    });
    lines.push("");
    lines.push(footer(data));
    return { kind: "product", found: "partial", query: query, matched: [], notFound: [query], lines: lines };
  }

  var byChain = priceByChain(top, results, Object.keys(data.chains));
  var used = {};
  lines.push(top.name);
  Object.keys(byChain).sort(function (a, b) { return byChain[a].price - byChain[b].price; })
    .forEach(function (c, i) {
      var p = byChain[c];
      used[p.name] = true;
      lines.push("   " + (i + 1) + ". " + chainName(c) + ": " + money(p.price) +
                 (p.same ? "" : " (מוצר דומה: " + p.name + ")"));
    });
  var others = results.slice(1).filter(function (r) { return r.score >= RELATED_SCORE && !used[r.name]; })
                      .slice(0, 3);
  if (others.length) {
    lines.push("");
    lines.push("אולי חיפשתם:");
    others.forEach(function (r) {
      lines.push("   - " + r.name + " - " + money(sortedPrices(r.prices)[0].price));
    });
  }
  lines.push("");
  lines.push(footer(data));
  var cheapest = Object.keys(byChain).sort(function (a, b) { return byChain[a].price - byChain[b].price; })[0];
  return { kind: "product", found: "yes", query: query, cheapest: cheapest,
           matched: [top.name], notFound: [],
           lines: lines };
}

function basketReply(req, data, index) {
  var chains = Object.keys(data.chains);
  var totals = {}, missing = {}, similar = {};
  chains.forEach(function (c) { totals[c] = 0; missing[c] = 0; similar[c] = 0; });

  var rows = [], notFound = [];
  req.lines.forEach(function (ln) {
    var results = search(index, ln.text, CANDIDATES);
    var r = results[0];
    if (!r || r.score < CONFIDENT_SCORE) { notFound.push(ln.text); return; }
    var byChain = priceByChain(r, results, chains);
    rows.push({ query: ln.text, item: r, qty: ln.qty, byChain: byChain });
    chains.forEach(function (c) {
      var p = byChain[c];
      if (!p) { missing[c]++; return; }
      totals[c] += p.price * ln.qty;
      if (!p.same) similar[c]++;
    });
  });

  var lines = [];
  if (!rows.length) {
    lines.push("לא מצאתי אף מוצר מהרשימה. נסו לכתוב כל מוצר בשורה נפרדת, למשל: חלב תנובה 3%");
    return { kind: "basket", found: "no", items: req.lines.length, matched: [], notFound: notFound,
             lines: lines };
  }

  var ranking = chains.map(function (c) { return { chain: c, total: totals[c], missing: missing[c] }; })
    .sort(function (a, b) { return (a.missing - b.missing) || (a.total - b.total); });

  lines.push("הסל שלכם (" + rows.length + " מוצרים):");
  var anySimilar = false;
  ranking.forEach(function (r, i) {
    var notes = [];
    if (i === 0 && !r.missing && chains.length > 1) notes.push("הכי זול");
    if (r.missing) notes.push("חסרים " + r.missing + " מוצרים");
    if (similar[r.chain]) { notes.push(similar[r.chain] + " מוצרים דומים*"); anySimilar = true; }
    lines.push("   " + chainName(r.chain) + ": " + money(r.total) + (notes.length ? " (" + notes.join(", ") + ")" : ""));
  });
  if (anySimilar) {
    lines.push("   * ברשת שאין בה את אותו מוצר בדיוק, חושב המוצר הדומה ביותר שלה.");
  }

  lines.push("");
  lines.push("פירוט (מה מצאתי לכל שורה):");
  rows.forEach(function (row) {
    var prices = Object.keys(row.byChain).map(function (c) { return row.byChain[c].price; });
    lines.push("   - " + row.item.name + (row.qty > 1 ? " x" + row.qty : "") +
               " - מ-" + money(Math.min.apply(null, prices) * row.qty));
  });

  if (notFound.length) {
    lines.push("");
    lines.push("לא מצאתי (לא נכללו בסכום): " + notFound.join(", "));
  }
  if (req.truncated) {
    lines.push("");
    lines.push("נבדקו רק " + MAX_BASKET_ITEMS + " המוצרים הראשונים.");
  }
  if (chains.length === 1) {
    lines.push("");
    lines.push("כרגע יש מחירים רק מ" + chainName(chains[0]) + ". רשתות נוספות יתווספו בקרוב.");
  }
  lines.push("");
  lines.push(footer(data));
  return { kind: "basket", found: notFound.length ? "partial" : "yes", items: req.lines.length,
           matched: rows.map(function (r) { return r.item.name; }), notFound: notFound,
           cheapest: ranking[0].chain, lines: lines };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toHtml(lines) {
  var body = lines.map(function (l) {
    return l ? "<div>" + escapeHtml(l).replace(/^ {3}/, "&nbsp;&nbsp;&nbsp;") + "</div>" : "<br>";
  }).join("");
  return '<div dir="rtl" style="text-align:right;font-family:Arial,sans-serif;font-size:15px;line-height:1.5">' +
         body + '<br><div style="color:#888;font-size:12px">' + BOT_NAME + "</div></div>";
}

if (typeof module !== "undefined") {
  // ב-Node: search מגיע מ-search.js. ב-Apps Script כל הקבצים חולקים את אותו מרחב שמות.
  global.search = require("./search.js").search;
  global.tokenize = require("./search.js").tokenize;
  module.exports = { handleMessage: handleMessage, parseRequest: parseRequest,
                     cleanEmailBody: cleanEmailBody };
}
