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
var CONFIDENT_SCORE = 0.8;    // מתחת לזה לא מנחשים, אלא מציעים אפשרויות
var RELATED_SCORE = 0.8;      // ציון מינימלי ל"אולי חיפשתם"
var MAX_BASKET_ITEMS = 40;    // רשימת קניות שבועית יכולה להיות ארוכה

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
    "העיר שלכם: כתבו פעם אחת, למשל:",
    "   עיר: בית שמש",
    "   ומאז אשווה רק בין הרשתות שיש להן סניף בעיר.",
    "",
    "המחירים מגיעים מקבצי המחירים הרשמיים שהרשתות מפרסמות לפי חוק.",
    "לצורך שיפור השירות נאסף מידע סטטיסטי על החיפושים, בלי שמירת כתובת המייל."
  ].join("\n");
}

// ---------------------------------------------------------------------------
// עיר
// ---------------------------------------------------------------------------
// prices.json מכיל cities: {עיר: {רשת: "r"|"n"}} (r = סניף רגיל, n = רק סניף שכונתי/יקר)
// ו-city_aliases: {כינוי: שם רשמי}. הנרמול זהה ל-norm_city ב-build_prices.py.
var MIN_CITY_CHAINS = 2;     // פחות מזה בעיר -> משווים בין כל הרשתות
var ALL_COUNTRY = "כל הארץ";

function normCity(s) {
  s = String(s || "").replace(/["'`׳״\-–()]/g, " ").replace(/יי/g, "י");
  return s.replace(/\s+/g, " ").trim();
}

/** מחזיר את השם הרשמי של העיר, או null אם לא זוהתה. */
function resolveUserCity(text, data) {
  var lookup = {};
  Object.keys(data.cities || {}).forEach(function (c) { lookup[normCity(c)] = c; });
  var aliases = data.city_aliases || {};
  Object.keys(aliases).forEach(function (a) { lookup[normCity(a)] = aliases[a]; });
  var n = normCity(text);
  if (lookup[n]) return lookup[n];
  if (n.charAt(0) === "ב" && lookup[n.slice(1)]) return lookup[n.slice(1)];   // "בבית שמש"
  return null;
}

/** "עיר: בית שמש", "אני גר בבני ברק", "עיר כל הארץ". מחזיר את טקסט העיר או null. */
function parseCityCommand(line) {
  // אחרי המילה חייב לבוא רווח, נקודתיים או סוף השורה, כדי ש"גרעיני חמניות" לא ייחשב פקודה
  var m = String(line || "").trim().match(/^(?:עיר|העיר שלי|אני גר|אני גרה|גר|גרה)(?:\s*[:\-]\s*|\s+|$)(.*)$/);
  return m ? m[1].trim() : null;
}

/**
 * אילו רשתות להשוות למשתמש מהעיר הזו.
 * מחזיר {chains, city, note}: note מוסבר למשתמש (או "" אם אין מה להסביר).
 */
function chainsForCity(data, city) {
  var all = Object.keys(data.chains);
  if (!city || city === ALL_COUNTRY) return { chains: all, city: "", note: "" };
  var inCity = (data.cities || {})[city] || {};
  var regular = Object.keys(inCity).filter(function (c) { return inCity[c] === "r"; });
  var neighborhood = Object.keys(inCity).filter(function (c) { return inCity[c] === "n"; });
  var notes = [];
  if (neighborhood.length) {
    notes.push("ב" + city + " יש גם סניף שכונתי של " + neighborhood.map(chainName).join(", ") +
               ". המחירים שם שונים ועדיין לא נכללים.");
  }
  if (regular.length < MIN_CITY_CHAINS) {
    notes.unshift(regular.length ?
      "ב" + city + " יש רק " + chainName(regular[0]) + ", ולכן מוצגות כל הרשתות." :
      "לא מצאתי סניפים של הרשתות שלנו ב" + city + ", ולכן מוצגות כל הרשתות.");
    return { chains: all, city: city, note: notes.join(" ") };
  }
  return { chains: regular, city: city, note: notes.join(" ") };
}

function cityReply(cityText, data) {
  if (!cityText) {
    return { kind: "city", found: "", lines: ["באיזו עיר אתם גרים? כתבו למשל: עיר: בית שמש"] };
  }
  if (normCity(cityText) === normCity(ALL_COUNTRY)) {
    return { kind: "city", found: "yes", setCity: "",
             lines: ["מעכשיו אשווה בין כל הרשתות בכל הארץ."] };
  }
  var city = resolveUserCity(cityText, data);
  if (!city) {
    return { kind: "city", found: "no",
             lines: ['לא זיהיתי את העיר "' + cityText + '". נסו לכתוב את השם המלא, למשל: עיר: בני ברק'] };
  }
  var sel = chainsForCity(data, city);
  var lines = ["שמרתי: " + city + "."];
  if (sel.chains.length < Object.keys(data.chains).length) {
    lines.push("מעכשיו אשווה בין הרשתות שיש להן סניף בעיר: " + sel.chains.map(chainName).join(", ") + ".");
  }
  if (sel.note) lines.push(sel.note);
  lines.push("");
  lines.push("אפשר לשלוח עכשיו מוצר או רשימת קניות. כדי לשנות עיר, כתבו שוב: עיר: <שם העיר>");
  return { kind: "city", found: "yes", setCity: city, lines: lines };
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

var TIE_SCORE = 0.03;          // הפרש ציון שנחשב "שוויון" בבחירת המוצר המרכזי
var TIE_PRICE_RATIO = 1.5;

/**
 * המוצר המרכזי לשורה: התוצאה הראשונה, אלא אם יש מוצר כמעט שווה בציון שנמכר ביותר רשתות
 * ולא יקר ממנה ביותר מפי 1.5 ("פסטה אסם" -> ספגטי אסם שבכל הרשתות, ולא "פסטה גן חיות";
 * אבל "במבה" לא תהפוך למארז ב-16.90).
 */
function pickReference(results) {
  var top = results[0], best = top;
  var topPrice = medianPrice(top.prices);
  results.forEach(function (r) {
    if (r.score < top.score - TIE_SCORE) return;
    if (medianPrice(r.prices) > topPrice * TIE_PRICE_RATIO) return;
    if (Object.keys(r.prices).length > Object.keys(best.prices).length) best = r;
  });
  return best;
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
/**
 * userCity: העיר השמורה של המשתמש ("" או undefined = כל הארץ).
 * אם ההודעה קובעת עיר, התשובה כוללת setCity (שם העיר, או "" לכל הארץ), והמתקשר שומר אותה.
 * עיר אפשר לקבוע בשורה הראשונה ולהמשיך באותה הודעה עם רשימת קניות.
 */
function handleMessage(text, data, index, userCity) {
  var lines = String(text || "").trim().split("\n");
  var cityText = parseCityCommand(lines[0]);
  var cityRes = null;
  if (cityText !== null) {
    cityRes = cityReply(cityText, data);
    if (cityRes.setCity !== undefined) userCity = cityRes.setCity;
    text = lines.slice(1).join("\n").trim();
    if (!text) return finish_(cityRes);
  }

  var sel = chainsForCity(data, userCity);
  var req = parseRequest(text);
  var res;
  if (req.kind === "help") {
    res = { kind: "help", found: "", matched: [], notFound: [], lines: [helpText()] };
  } else if (req.kind === "product") {
    res = productReply(req.lines[0].text, data, index, sel);
  } else {
    res = basketReply(req, data, index, sel);
  }
  if (cityRes) {                               // עיר + רשימה באותה הודעה
    res.lines = cityRes.lines.slice(0, -2).concat([""], res.lines);
    res.setCity = cityRes.setCity;
  }
  res.city = sel.city;
  return finish_(res);
}

function finish_(res) {
  res.matched = res.matched || [];
  res.notFound = res.notFound || [];
  res.text = res.lines.join("\n");
  res.html = toHtml(res.lines);
  return res;
}

/** שורות הסיום: תאריך, איזה רשתות הושוו, וטיפ לבחירת עיר. */
function footerLines(data, sel) {
  var out = [];
  if (sel.note) out.push(sel.note);
  if (sel.city && sel.chains.length < Object.keys(data.chains).length) {
    out.push("השוואה בין הרשתות ב" + sel.city + ". לשינוי: עיר: <שם העיר>");
  } else if (!sel.city) {
    out.push("טיפ: כתבו \"עיר: <שם העיר>\" כדי להשוות רק בין הרשתות שיש בעיר שלכם.");
  }
  out.push(footer(data));
  return out;
}

function productReply(query, data, index, sel) {
  var results = search(index, query, CANDIDATES);
  var lines = [];
  if (!results.length) {
    lines.push('לא מצאתי "' + query + '".');
    lines.push("נסו לכתוב את שם המוצר אחרת, או עם שם היצרן (למשל: חלב תנובה 3%).");
    return { kind: "product", found: "no", query: query, matched: [], notFound: [query], lines: lines };
  }

  var top = results[0].score >= CONFIDENT_SCORE ? pickReference(results) : results[0];
  if (top.score < CONFIDENT_SCORE) {
    lines.push('לא מצאתי בדיוק את "' + query + '". התכוונתם ל:');
    results.slice(0, 3).forEach(function (r, i) {
      lines.push("   " + (i + 1) + ". " + r.name + " - " + money(sortedPrices(r.prices)[0].price));
    });
    lines.push("");
    lines.push.apply(lines, footerLines(data, sel));
    return { kind: "product", found: "partial", query: query, matched: [], notFound: [query], lines: lines };
  }

  var byChain = priceByChain(top, results, sel.chains);
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
  lines.push.apply(lines, footerLines(data, sel));
  var cheapest = Object.keys(byChain).sort(function (a, b) { return byChain[a].price - byChain[b].price; })[0];
  return { kind: "product", found: "yes", query: query, cheapest: cheapest,
           matched: [top.name], notFound: [],
           lines: lines };
}

function basketReply(req, data, index, sel) {
  var chains = sel.chains;
  var rows = [], notFound = [], suggestions = {};
  req.lines.forEach(function (ln) {
    var results = search(index, ln.text, CANDIDATES);
    if (!results.length || results[0].score < CONFIDENT_SCORE) {
      notFound.push(ln.text);
      if (results.length && results[0].score >= 0.5) suggestions[ln.text] = results[0].name;
      return;
    }
    var r = pickReference(results);
    var byChain = priceByChain(r, results, chains);
    rows.push({ query: ln.text, item: r, qty: ln.qty, byChain: byChain });
  });

  var lines = [];
  if (!rows.length) {
    lines.push("לא מצאתי אף מוצר מהרשימה. נסו לכתוב כל מוצר בשורה נפרדת, למשל: חלב תנובה 3%");
    return { kind: "basket", found: "no", items: req.lines.length, matched: [], notFound: notFound,
             lines: lines };
  }

  // השוואה הוגנת: רק על מוצרים שיש בכל הרשתות שמשווים. מוצר שחסר ברשת לא "מוזיל" אותה.
  var common = rows.filter(function (row) { return chains.every(function (c) { return row.byChain[c]; }); });
  var partial = rows.filter(function (row) { return common.indexOf(row) < 0; });
  var compareRows = common.length ? common : rows;
  var ranking = chains.map(function (c) {
    var total = 0, sim = 0, miss = 0;
    compareRows.forEach(function (row) {
      var p = row.byChain[c];
      if (!p) { miss++; return; }
      total += p.price * row.qty;
      if (!p.same) sim++;
    });
    return { chain: c, total: total, similar: sim, missing: miss };
  }).sort(function (a, b) { return (a.missing - b.missing) || (a.total - b.total); });

  if (!partial.length) {
    lines.push("הסל שלכם (" + rows.length + " מוצרים):");
  } else if (common.length) {
    lines.push("הסל שלכם (" + rows.length + " מוצרים). השוואה על " + common.length +
               " המוצרים שיש בכל הרשתות:");
  } else {
    lines.push("הסל שלכם (" + rows.length + " מוצרים). אין מוצר שנמצא בכל הרשתות, ולכן הסכומים חלקיים:");
  }
  var anySimilar = false;
  ranking.forEach(function (r, i) {
    var notes = [];
    if (i === 0 && !r.missing && chains.length > 1) notes.push("הכי זול");
    if (r.missing) notes.push("חסרים " + r.missing + " מוצרים");
    if (r.similar) { notes.push(r.similar + " מוצרים דומים*"); anySimilar = true; }
    lines.push("   " + chainName(r.chain) + ": " + money(r.total) + (notes.length ? " (" + notes.join(", ") + ")" : ""));
  });
  if (anySimilar) {
    lines.push("   * ברשת שאין בה את אותו מוצר בדיוק, חושב המוצר הדומה ביותר שלה.");
  }

  lines.push("");
  lines.push("פירוט (מה מצאתי לכל שורה):");
  compareRows.forEach(function (row) {
    var prices = Object.keys(row.byChain).map(function (c) { return row.byChain[c].price; });
    lines.push("   - " + row.item.name + (row.qty > 1 ? " x" + row.qty : "") +
               " - מ-" + money(Math.min.apply(null, prices) * row.qty));
  });

  if (common.length && partial.length) {
    lines.push("");
    lines.push("לא בכל הרשתות (לא נכללו בהשוואה):");
    partial.forEach(function (row) {
      var have = chains.filter(function (c) { return row.byChain[c]; })
                       .sort(function (a, b) { return row.byChain[a].price - row.byChain[b].price; });
      var lack = chains.filter(function (c) { return !row.byChain[c]; });
      lines.push("   - " + row.item.name + (row.qty > 1 ? " x" + row.qty : "") + ": " +
                 have.map(function (c) { return chainName(c) + " " + money(row.byChain[c].price * row.qty); })
                     .join(", ") +
                 " (אין: " + lack.map(chainName).join(", ") + ")");
    });
  }

  if (notFound.length) {
    lines.push("");
    lines.push("לא מצאתי:");
    notFound.forEach(function (q) {
      lines.push("   - " + q + (suggestions[q] ? " (אולי: " + suggestions[q] + "?)" : ""));
    });
  }
  if (req.truncated) {
    lines.push("");
    lines.push("נבדקו רק " + MAX_BASKET_ITEMS + " המוצרים הראשונים.");
  }
  lines.push("");
  lines.push.apply(lines, footerLines(data, sel));
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
