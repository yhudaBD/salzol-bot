/**
 * search.js  -  שלב 2: חיפוש מוצר לפי טקסט חופשי בעברית
 *
 * אותו קובץ רץ גם ב-Node (לבדיקות) וגם ב-Google Apps Script (בבוט),
 * ולכן אין בו import/require, רק פונקציות רגילות.
 *
 * שימוש:
 *   var index = buildIndex(pricesJson.items);
 *   var results = search(index, "חלב תנובה 3%", 5);
 *   // [{code, name, brand, prices, score}, ...] מהמתאים ביותר
 *
 * איך זה עובד:
 *   1. נרמול: בלי ניקוד וגרשיים, אותיות סופיות -> רגילות, "3 אחוז" -> "3%",
 *      מספר צמוד למילה מופרד ("2ליטר" -> "2 ליטר"), יחידות מאוחדות ("לי" -> "ליטר").
 *   2. השוואה ברמת מילה (לא מחרוזת), כדי ש"חלה" לא ימצא את "אחלה".
 *   3. כל מילה בחיפוש מקבלת ציון לפי ההתאמה הטובה ביותר שלה בשם המוצר:
 *      זהה, תחילת מילה, שם קטוע, יחיד/רבים, אות שימוש (ב/ה/ו/ל/מ/ש/כ), שגיאת הקלדה אחת.
 *   4. מספרים חייבים להתאים בדיוק (3% זה לא 1%).
 *   5. בונוס כשהמילה הראשונה בחיפוש היא גם הראשונה בשם ("חלב" -> "חלב תנובה" ולא "שוקולד חלב").
 */

// ---------------------------------------------------------------------------
// מילים נרדפות: מילה בחיפוש -> מילים שאפשר למצוא במקומה בשם המוצר.
// כתובות אחרי נרמול (בלי אותיות סופיות). מעדכנים לפי חיפושים שלא נמצאו ביומן.
// ---------------------------------------------------------------------------
var SYNONYMS = {
  "ביצה": ["ביצימ"],
  "ביצי": ["ביצימ"],
  "בינוני": ["בנוני", "m"],
  "בינוניות": ["בינוני", "בנוני", "m"],
  "גדול": ["l"],
  "גדולות": ["גדול", "l"],
  "גדולה": ["גדול", "l"],
  "קטנות": ["קטנ", "s"],
  "l": ["גדול"],
  "m": ["בינוני", "בנוני"],
  "קולה": ["קוקה"]
};

// ברירות מחדל לחיפושים כלליים: כשמחפשים רק "סוכר", מוצר עם המילים האלה יעלה ראשון.
// המפתח והמילים כתובים כמו שאדם כותב (הנרמול נעשה אוטומטית). מרחיבים לפי היומן.
var PREFERRED = {
  "סוכר": ["סוכר", "לבן", "1", "קג"],
  "מלח": ["מלח", "שולחן"],
  "קמח": ["קמח", "לבן"],
  "חלב": ["חלב", "3%", "1", "ליטר"],
  "ביצים": ["ביצים", "12", "L"],
  "ביצים L": ["ביצים", "12", "L"],
  "ביצים M": ["ביצים", "12", "M"],
  "במבה": ["במבה", "חטיף", "בוטנים", "אסם"],
  "נייר טואלט": ["נייר", "טואלט", "32"],
  "שמן זית": ["שמן", "זית", "כתית"],
  "קולה זירו": ["קוקה", "קולה", "זירו"],
  "אורז": ["אורז", "עגול"],
  "שמן": ["שמן", "קנולה"],
  "לחם": ["לחם", "אחיד", "פרוס", "750"],
  "לחם אחיד": ["לחם", "אחיד", "פרוס", "750"]
};

// מילים תיאוריות: אם הן לא מופיעות בשם המוצר, לא מורידים עליהן ציון.
// ("מעדן מילקי" -> המוצרים נקראים "מילקי בטעם שוקולד"). כתובות אחרי נרמול.
var OPTIONAL_WORDS = {};
["מעדנ", "משקה", "חטיפ", "לשולחנ", "נשלפ", "נייר", "של", "עמ", "שקית", "אריזה", "בקבוק",
 "קופסה", "מארז", "רגיל", "רגילה", "טרי", "טריה"].forEach(function (w) { OPTIONAL_WORDS[w] = true; });

// ביטויים שהרשתות כותבות אחרת. מוחלפים בחיפוש לפני הכול (אחרי נרמול).
var PHRASES = {
  "סבונ כלימ": "נוזל כלימ",
  "סבונ לכלימ": "נוזל כלימ",
  "נוזל לכלימ": "נוזל כלימ"
};

// יחידות: כל הצורות -> צורה אחת
var UNITS = {
  "ליטר": "ליטר", "לי": "ליטר", "ליט": "ליטר", "ל": "ליטר",
  "גרמ": "גרמ", "גר": "גרמ", "ג": "גרמ",
  "קג": "קג", "קילו": "קג", "ק": "קג",
  "מל": "מל",
  "יח": "יח", "יחידות": "יח", "יחידה": "יח", "יחי": "יח"
};

var PREFIX_LETTERS = "בהולמשכ";
var FINALS = { "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ" };

// ---------------------------------------------------------------------------
// נרמול
// ---------------------------------------------------------------------------
function normalize(text) {
  var s = String(text || "").toLowerCase();
  s = s.replace(/[֑-ׇ]/g, "");                    // ניקוד וטעמים
  s = s.replace(/['"`׳״’“”]/g, ""); // גרש, גרשיים, מירכאות
  s = s.replace(/[ךםןףץ]/g, function (c) { return FINALS[c]; });
  s = s.replace(/(\d)\s*(אחוזימ|אחוז)/g, "$1%");             // "3 אחוז" -> "3%"
  s = s.replace(/(\d)\s+%/g, "$1%");                          // "3 %" -> "3%"
  s = s.replace(/(\d)([^\d%.\s])/g, "$1 $2");                 // "2ליטר" -> "2 ליטר"
  s = s.replace(/([^\d\s.])(\d)/g, "$1 $2");                  // "x2" -> "x 2"
  s = s.replace(/[^א-תa-z0-9%.\s]/g, " ");          // כל השאר -> רווח
  s = s.replace(/(^|\s)\.|\.(\s|$)/g, " ");                   // נקודה שאינה בתוך מספר
  return s.replace(/\s+/g, " ").trim();
}

function tokenize(text) {
  var out = [];
  var parts = normalize(text).split(" ");
  for (var i = 0; i < parts.length; i++) {
    var t = parts[i];
    if (!t) continue;
    if (UNITS.hasOwnProperty(t)) t = UNITS[t];
    out.push(t);
  }
  return out;
}

function isNumber(t) {
  return /^\d+(\.\d+)?%?$/.test(t);
}

// יחיד/רבים ונקבה בצורה גסה: "ביצימ"->"ביצ", "גדולות"->"גדול"
function stem(t) {
  if (t.length > 4 && /(ימ|ות)$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && /[הת]$/.test(t)) return t.slice(0, -1);
  return t;
}

function editDistanceAtMost1(a, b) {
  if (a === b) return true;
  var la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  var i = 0, j = 0, diff = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (la > lb) i++;
    else if (lb > la) j++;
    else { i++; j++; }
  }
  return diff + (la - i) + (lb - j) <= 1;
}

// ---------------------------------------------------------------------------
// ציון התאמה בין מילה בחיפוש למילה בשם המוצר (0 עד 1)
// ---------------------------------------------------------------------------
function wordScore(q, t, isLastOfTruncated, exact) {
  if (q === t) return 1;
  if (q.length >= 2 && t.indexOf(q) === 0) return 0.85;              // התחלה: "קוט" -> "קוטג"
  if (q.length >= 3 && stem(q) === stem(t)) return 0.8;               // יחיד/רבים
  if (isLastOfTruncated && t.length >= 2 && q.indexOf(t) === 0) {      // שם קטוע: "שו" <- "שומנ"
    return 0.4 + 0.4 * t.length / q.length;                           // כמה שנשאר יותר מהמילה, ציון גבוה יותר
  }
  if (t.length >= 4 && PREFIX_LETTERS.indexOf(t[0]) >= 0) {           // אות שימוש: "בשמנ" -> "שמנ"
    var rest = t.slice(1);
    if (rest === q) return 0.75;                                      // "בגליל" -> "גליל"
    if (q.length >= 3 && rest.indexOf(q) === 0) return 0.6;
  }
  if (!exact && q.length >= 4 && t.length >= 4 && editDistanceAtMost1(q, t)) return 0.7; // שגיאת הקלדה
  if (t.length >= 3 && q.indexOf(t) === 0) return 0.5;
  return 0;
}

function numberScore(q, t) {
  if (!isNumber(t)) return 0;
  var qn = parseFloat(q), tn = parseFloat(t);
  if (qn !== tn) return 0;
  var qp = q.slice(-1) === "%", tp = t.slice(-1) === "%";
  return qp === tp ? 1 : 0.8;
}

// ---------------------------------------------------------------------------
// אינדקס
// ---------------------------------------------------------------------------
var TRUNCATED_LEN = 19;   // שמות באורך כזה ומעלה כנראה נקטעו (רמי לוי חותכת ב-20)

function buildIndex(items) {
  var list = [];
  for (var code in items) {
    if (!items.hasOwnProperty(code)) continue;
    var it = items[code];
    list.push({
      code: code,
      name: it.n,
      brand: it.b,
      prices: it.p,
      tokens: tokenize(it.n),
      brandTokens: tokenize(it.b),
      truncated: String(it.n).length >= TRUNCATED_LEN
    });
  }
  return list;
}

function bestMatch(q, item, exact) {
  var best = 0, pos = -1;
  var toks = item.tokens;
  var alts = SYNONYMS[q] || [];
  for (var i = 0; i < toks.length; i++) {
    var last = item.truncated && i === toks.length - 1;
    var s;
    if (isNumber(q)) {
      s = numberScore(q, toks[i]);
    } else {
      s = wordScore(q, toks[i], last, exact);
      for (var a = 0; a < alts.length && s < 1; a++) {
        s = Math.max(s, 0.95 * wordScore(alts[a], toks[i], last, exact));
      }
    }
    if (s > best) { best = s; pos = i; }
  }
  if (!isNumber(q)) {
    for (var b = 0; b < item.brandTokens.length; b++) {
      var bs = 0.9 * wordScore(q, item.brandTokens[b], false);
      if (bs > best) { best = bs; pos = -1; }
    }
  }
  return { score: best, pos: pos };
}

// strict: בלי לסלוח על מילה חסרה ובלי שגיאות הקלדה (לברירות מחדל, שם כל אות חשובה:
// "קוקה" ו"קולה" שונות באות אחת)
function scoreItem(qTokens, item, strict) {
  var total = 0, minWord = 1, firstBonus = 0, numbersOk = true, inOrder = true, lastPos = -1;
  var counted = 0, factor = 1;
  var matches = qTokens.map(function (q) { return bestMatch(q, item, strict); });
  // בחיפוש של 3 מילים ומעלה, מילה אחת שחסרה בשם לא מפילה את ההתאמה
  // ("אבקת כביסה אריאל" -> "אבקת אריאל שושן צחור"), רק מורידה קצת.
  var missed = [];
  qTokens.forEach(function (q, i) {
    if (matches[i].score < 0.5 && !isNumber(q) && !OPTIONAL_WORDS[q]) missed.push(i);
  });
  var forgiven = (!strict && qTokens.length >= 3 && missed.length === 1) ? missed[0] : -1;
  if (forgiven >= 0) factor = 0.9;
  for (var i = 0; i < qTokens.length; i++) {
    var m = matches[i];
    if (i === forgiven) continue;
    // מילה תיאורית שלא מופיעה בשם ("מעדן מילקי", "גליל ניילון לשולחן") - מתעלמים ממנה
    if (m.score < 0.5 && OPTIONAL_WORDS[qTokens[i]] && qTokens.length > 1) continue;
    counted++;
    total += m.score;
    if (m.pos !== lastPos + 1) inOrder = false;
    lastPos = m.pos;
    if (isNumber(qTokens[i])) {
      if (m.score === 0) numbersOk = false;
    } else if (m.score < minWord) {
      minWord = m.score;
    }
    if (i === 0 && m.pos === 0 && m.score >= 0.8) firstBonus = 0.1;
  }
  if (!counted) return 0;
  var score = (total / counted + firstBonus) * factor;
  if (inOrder && counted > 1) score += 0.05;   // המילים ברצף ובסדר, מתחילת השם ("קמח לבן ...")
  if (minWord < 0.5) score *= 0.5;          // מילה מהחיפוש לא נמצאה בכלל
  if (!numbersOk) score *= 0.6;             // מספר לא תואם (3% מול 1%)
  score -= 0.01 * Math.max(0, item.tokens.length - counted);  // עדיפות לשם קצר וממוקד
  return score;
}

function minPrice(prices) {
  var m = Infinity;
  for (var c in prices) if (prices.hasOwnProperty(c) && prices[c] < m) m = prices[c];
  return m;
}

var preferredCache = null;
function preferredTokens(qTokens) {
  if (!preferredCache) {
    preferredCache = {};
    for (var k in PREFERRED) {
      if (PREFERRED.hasOwnProperty(k)) {
        preferredCache[tokenize(k).join(" ")] = tokenize(PREFERRED[k].join(" "));
      }
    }
  }
  // התאמה גם כשהחיפוש מתחיל בביטוי ויש אחריו עוד מילים ("קולה זירו 1.5"): הארוך מנצח
  for (var n = qTokens.length; n > 0; n--) {
    var pref = preferredCache[qTokens.slice(0, n).join(" ")];
    if (pref) {
      var rest = qTokens.slice(n);
      // המשתמש כתב מספר משלו ("חלב 1%") - המספרים של ברירת המחדל (3%) לא רלוונטיים
      if (rest.some(isNumber)) pref = pref.filter(function (t) { return !isNumber(t); });
      return pref.concat(rest);
    }
  }
  return null;
}

/**
 * מחזיר עד n תוצאות, מהטובה לגרועה. מוצרים עם שם ומחיר זהים מאוחדים.
 * minScore: ציון מינימלי (ברירת מחדל 0.4) כדי לא להחזיר זבל.
 */
function search(index, query, n, minScore) {
  n = n || 5;
  minScore = minScore === undefined ? 0.4 : minScore;
  var normQuery = normalize(query);
  for (var ph in PHRASES) {
    if (PHRASES.hasOwnProperty(ph)) normQuery = (" " + normQuery + " ").replace(" " + ph + " ", " " + PHRASES[ph] + " ").trim();
  }
  var qTokens = tokenize(normQuery);
  if (!qTokens.length) return [];

  var preferred = preferredTokens(qTokens);
  var scored = [];
  for (var i = 0; i < index.length; i++) {
    var s = scoreItem(qTokens, index[i]);
    if (s < minScore) continue;
    if (preferred) s += 0.2 * scoreItem(preferred, index[i], true);
    scored.push({ item: index[i], score: s });
  }
  // בציון זהה (כמעט) - הזול קודם, כי בדרך כלל זו האריזה הבסיסית (1 ליטר לפני 2 ליטר)
  scored.sort(function (a, b) {
    var d = Math.round((b.score - a.score) * 200);
    return d !== 0 ? d : minPrice(a.item.prices) - minPrice(b.item.prices);
  });

  var out = [], seen = {};
  for (var j = 0; j < scored.length && out.length < n; j++) {
    var it = scored[j].item;
    var key = it.tokens.join(" ") + "|" + JSON.stringify(it.prices);
    if (seen[key]) continue;
    seen[key] = true;
    out.push({ code: it.code, name: it.name, brand: it.brand, prices: it.prices,
               score: Math.round(scored[j].score * 1000) / 1000 });
  }
  return out;
}

if (typeof module !== "undefined") {
  module.exports = { normalize: normalize, tokenize: tokenize, buildIndex: buildIndex,
                     search: search, SYNONYMS: SYNONYMS };
}
