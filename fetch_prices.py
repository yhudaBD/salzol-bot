#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_prices.py  -  הורדת קבצי מחירים מהרשתות

מקורות: הפורטל המשותף (url.publishedprices.co.il) ואתר המחירים של שופרסל.

מה הסקריפט עושה:
  1. מתחבר לפורטל עם שם המשתמש של הרשת (בלי סיסמה).
  2. מוריד את קובץ הסניפים העדכני ושומר רשימת סניפים: stores_<רשת>.json
  3. מוריד לכל סניף את קובץ ה-PriceFull העדכני ביותר אל raw/<רשת>/
     (קבצי PriceFull ישנים בתיקייה נמחקים קודם, כדי לא לערבב ימים).

איך מפעילים:
      python fetch_prices.py                  # רמי לוי, סניפים רגילים בלבד
      python fetch_prices.py --category all   # כל הסניפים (רגילים, שכונתיים, אינטרנט), חוץ ממוחרגים
      python fetch_prices.py --build          # ואז מריץ גם את build_prices.py
      python fetch_prices.py --city ירושלים   # רק סניפי עיר אחת (כותב stores_filter.json)
      python fetch_prices.py --limit 3        # רק 3 סניפים, לבדיקה מהירה

הסקריפט משתמש רק בספרייה הסטנדרטית של פייתון. אין מה להתקין.
"""

import argparse
import http.cookiejar
import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
import xml.etree.ElementTree as ET
import io

from build_prices import (CITY_ALIASES, RAW_DIR, STORES_FILTER_FILE, decode_xml, local_tag,
                          norm_city, norm_sub_chain, unpack_to_xml_list)

# ---------------------------------------------------------------------------
# הגדרות שאפשר לשנות
# ---------------------------------------------------------------------------
PORTAL = "https://url.publishedprices.co.il"

# רשתות: שם התיקייה ב-raw -> הגדרות.
#   user: שם משתמש בפורטל המשותף. source="shufersal": האתר של שופרסל.
#   sub_chains: רק תתי-רשת מסוימות (בשופרסל: 6 = יש חסד).
# כדי להוסיף רשת (שלב 6) מוסיפים כאן שורה.
#   neighborhood_from: מספר סניף שממנו והלאה הסניף "שכונתי" (המחירים בהם יקרים יותר).
#   בקובץ הסניפים אין שדה שמבדיל ביניהם, ולכן מזהים לפי מספר הסניף.
#   neighborhood: סניפים שכונתיים נוספים שהמספר שלהם נמוך מ-neighborhood_from.
#   excluded: סניפים שלא מורידים בכלל (למשל אילת, שבה אין מע"מ והמחירים לא מייצגים).
CHAINS = {
    #   city_overrides: עיר ידנית לסניפים שאי אפשר לזהות את העיר שלהם מהקובץ.
    "rami_levy": {"user": "RamiLevi", "neighborhood_from": 700,
                  "neighborhood": ["1-3"],  # 1-3 = רמות, ירושלים
                  "excluded": ["1-203"],    # 1-203 = אילת
                  "city_overrides": {"1-8": "שער בנימין", "1-23": "גוש עציון"}},
    "osher_ad": {"user": "osherad"},
    # יש חסד = תת-רשת 6 של שופרסל (אתר נפרד, בלי התחברות)
    "yesh_hesed": {"source": "shufersal", "sub_chains": ["6"]},
    # KT מרקט מפרסמת בשם "משנת יוסף" (KT שיווק), 4 סניפים בבית שמש וחריש
    "kt_market": {"source": "bina", "prefix": "ktshivuk"},
    # ויקטורי הוסרה (4.10.2026): laibcatalog עונה רק לכתובות מישראל, ו-GitHub Actions רץ מחו"ל.
    # להחזרה, אם העדכון יעבור לרוץ מישראל:
    #   "victory": {"source": "laib", "chain_id": "7290696200003",
    #               "neighborhood": ["1-16", "1-31", "1-35", "1-57", "1-67", "1-75", "1-80"]},
    # ביוחננוף אין סניפים "שכונתיים", אבל יש סניפים יקרים יותר (+5%, ואחד העם ת"א +13%).
    # הם מסווגים כאן כ-neighborhood כדי שלא ייכנסו למחיר הרגיל. נבדק ב-4.10.2026.
    "yochananof": {"user": "yohananof",
                   "neighborhood": ["1-8", "1-15", "1-16", "1-18", "1-25", "1-29", "1-33", "1-35",
                                    "1-41", "1-42", "1-48", "1-53", "1-54", "1-59"],
                   # יוחננוף לא ממלאת עיר בקובץ הסניפים. אלה הסניפים שהשם שלהם לא מספיק לזיהוי.
                   "city_overrides": {"1-4": "קרית עקרון", "1-13": "חיפה",
                                      "1-27": "תל אביב - יפו", "1-34": "אשקלון",
                                      "1-46": "מעלה אדומים", "1-146": "מעלה אדומים"}},
}

# קטגוריות סניפים: regular = רגיל, neighborhood = שכונתי, online = אתר אינטרנט,
# excluded = מוחרג (לא יורד גם עם --category all)
CATEGORIES = ("regular", "neighborhood", "online", "excluded")
STORE_TYPE_ONLINE = "2"   # StoreType בקובץ הסניפים

# קודי ערים של הלמ"ס, כי בקובץ הסניפים העיר מופיעה כמספר ולא כשם.
# אפשר גם להעביר ל---city את הקוד עצמו.
CITY_CODES = {
    "ירושלים": "3000", "בני ברק": "6100", "תל אביב": "5000", "חיפה": "4000",
    "בית שמש": "2610", "מודיעין עילית": "3797", "ביתר עילית": "3780",
    "אלעד": "1309", "אשדוד": "70", "פתח תקווה": "7900", "צפת": "8000",
    "טבריה": "6700",
}

DOWNLOAD_PAUSE = 0.5   # שניות בין הורדות, כדי לא להעמיס על הפורטל
TIMEOUT = 120

# שני פורמטים של שמות קבצים שראינו בפורטל:
#   PriceFull7290058140886-001-002-20261004-001000.gz   (תת-רשת, סניף, תאריך, שעה)
#   pricefull7290058140886-039-202610040514.gz          (סניף בלבד, תאריך+שעה צמודים)
PRICEFULL_RE = re.compile(
    r"^pricefull(\d+)-(?:(\d+)-)?(\d+)-(\d{8})-?(\d{4,6})\.", re.IGNORECASE)
STORES_RE = re.compile(r"^stores(\d+)-.*?(\d{8})-?(\d{3,6})\.", re.IGNORECASE)  # שופרסל: שעה בת 3 ספרות


def norm_id(s):
    """'001' -> '1'. אותו נרמול כמו ב-parse_price_xml, כדי שמזהי הסניפים יתאימו."""
    return (s or "").strip().lstrip("0") or "0"


# ---------------------------------------------------------------------------
# מקורות קבצים. לכל מקור אותו ממשק:
#   login()              - התחברות (או כלום, אם אין צורך)
#   stores_file()        - (שם, תוכן) של קובץ הסניפים העדכני, או (None, None)
#   pricefull_files(keys) - dict: מזהה סניף -> שם קובץ PriceFull עדכני
#                          (keys=None: כל הסניפים שיש להם קובץ)
#   download(fname)      - תוכן הקובץ
# ---------------------------------------------------------------------------
class HttpSource:
    def __init__(self, insecure=False):
        ctx = ssl.create_default_context()
        if insecure:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
            urllib.request.HTTPSHandler(context=ctx))
        self.opener.addheaders = [("User-Agent", "Mozilla/5.0 (price-bot)")]

    def _open(self, url, data=None):
        body = urllib.parse.urlencode(data).encode() if data is not None else None
        try:
            return self.opener.open(url, body, timeout=TIMEOUT)
        except urllib.error.URLError as e:
            if isinstance(e.reason, ssl.SSLCertVerificationError):
                sys.exit("אימות תעודת האבטחה נכשל (%s).\n"
                         "אם אתה סומך על הרשת שלך, אפשר להריץ שוב עם --insecure" % e.reason)
            raise


class CerberusPortal(HttpSource):
    """הפורטל המשותף url.publishedprices.co.il (רמי לוי, אושר עד, יוחננוף ועוד)."""

    def __init__(self, user, insecure=False):
        HttpSource.__init__(self, insecure)
        self.user = user
        self.token = None
        self.files = None

    @staticmethod
    def _csrf(html):
        m = re.search(r'name="csrftoken"\s+content="([^"]+)"', html)
        if not m:
            raise RuntimeError("לא נמצא csrftoken בדף. ייתכן שהפורטל שינה מבנה.")
        return m.group(1)

    def login(self):
        html = self._open(PORTAL + "/login").read().decode("utf-8", "replace")
        resp = self._open(PORTAL + "/login/user", {
            "r": "", "username": self.user, "password": "",
            "Submit": "Sign in", "csrftoken": self._csrf(html)})
        page = resp.read().decode("utf-8", "replace")
        if "/login" in resp.geturl():
            raise RuntimeError("ההתחברות נכשלה עבור המשתמש '%s'." % self.user)
        self.token = self._csrf(page)       # הדף /file מכיל טוקן חדש לבקשות הבאות

    def _list(self):
        if self.files is None:
            resp = self._open(PORTAL + "/file/json/dir", {
                "sEcho": "1", "iColumns": "5", "iDisplayStart": "0",
                "iDisplayLength": "100000", "cd": "/", "csrftoken": self.token})
            data = json.loads(resp.read().decode("utf-8"))
            self.files = [row["fname"] for row in data.get("aaData", [])]
            print("בפורטל %d קבצים" % len(self.files))
        return self.files

    def stores_file(self):
        name = latest_stores_file(self._list())
        return (name, self.download(name)) if name else (None, None)

    def pricefull_files(self, keys):
        best = latest_pricefull_per_store(self._list())
        return best if keys is None else {k: v for k, v in best.items() if k in keys}

    def download(self, fname):
        return self._open(PORTAL + "/file/d/" + urllib.parse.quote(fname)).read()


class ShufersalPortal(HttpSource):
    """prices.shufersal.co.il: בלי התחברות. רשימת קבצים לפי קטגוריה וסניף, הקבצים עצמם ב-Azure."""
    LIST_URL = "https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=%d&storeId=%s&page=1"
    CAT_PRICEFULL, CAT_STORES = 2, 5

    def __init__(self, insecure=False):
        HttpSource.__init__(self, insecure)
        self.urls = {}                       # שם קובץ -> קישור הורדה (חתום, בתוקף כשעה)

    def login(self):
        pass

    def _links(self, cat, store_id):
        html = self._open(self.LIST_URL % (cat, store_id)).read().decode("utf-8", "replace")
        names = []
        for url in re.findall(r'href="(https://[^"]+\.blob\.core\.windows\.net/[^"]+)"', html):
            url = url.replace("&amp;", "&")
            name = urllib.parse.unquote(url.split("?")[0].rsplit("/", 1)[-1])
            self.urls[name] = url
            names.append(name)
        return names

    def stores_file(self):
        name = latest_stores_file(self._links(self.CAT_STORES, 0))
        return (name, self.download(name)) if name else (None, None)

    def pricefull_files(self, keys):
        if keys is None:
            raise RuntimeError("בשופרסל צריך רשימת סניפים (אין רשימה של כל הקבצים בבת אחת)")
        out = {}
        for key in sorted(keys):
            best = latest_pricefull_per_store(self._links(self.CAT_PRICEFULL, key.split("-")[-1]))
            if key in best:
                out[key] = best[key]
            time.sleep(DOWNLOAD_PAUSE)
        return out

    def download(self, fname):
        return self._open(self.urls[fname]).read()


class LaibPortal(HttpSource):
    """laibcatalog.co.il (ויקטורי, מחסני השוק, ח. כהן). עונה רק לכתובות IP מישראל."""
    BASE = "https://laibcatalog.co.il/webapi"

    def __init__(self, chain_id, insecure=False):
        HttpSource.__init__(self, insecure)
        self.chain_id = chain_id
        self.files = None

    def login(self):
        pass

    def _list(self):
        if self.files is None:
            data = json.loads(self._open("%s/api/getfiles?edi=%s" % (self.BASE, self.chain_id))
                              .read().decode("utf-8"))
            self.files = [row["fileName"] for row in data]
            print("בפורטל %d קבצים" % len(self.files))
        return self.files

    def stores_file(self):
        name = latest_stores_file(self._list())
        return (name, self.download(name)) if name else (None, None)

    def pricefull_files(self, keys):
        best = latest_pricefull_per_store(self._list())
        return best if keys is None else {k: v for k, v in best.items() if k in keys}

    def download(self, fname):
        return self._open("%s/%s/%s" % (self.BASE, self.chain_id, urllib.parse.quote(fname))).read()


class BinaPortal(HttpSource):
    """{prefix}.binaprojects.com (משנת יוסף/KT, קינג סטור ועוד). בלי התחברות."""
    FILE_TYPES = {"stores": "1", "pricefull": "4"}

    def __init__(self, prefix, insecure=False):
        HttpSource.__init__(self, insecure)
        self.base = "https://%s.binaprojects.com" % prefix

    def login(self):
        pass

    def _list(self, kind):
        rows = json.loads(self._open(self.base + "/MainIO_Hok.aspx", {
            "WStore": "", "WDate": "", "WFileType": self.FILE_TYPES[kind]}).read().decode("utf-8"))
        return [(r.get("FileNm") or "").strip() for r in rows if r.get("FileNm")]

    def stores_file(self):
        name = latest_stores_file(self._list("stores"))
        return (name, self.download(name)) if name else (None, None)

    def pricefull_files(self, keys):
        best = latest_pricefull_per_store(self._list("pricefull"))
        return best if keys is None else {k: v for k, v in best.items() if k in keys}

    def download(self, fname):
        return self._open(self.base + "/Download/" + urllib.parse.quote(fname)).read()


def make_source(cfg, insecure):
    if cfg.get("source") == "shufersal":
        return ShufersalPortal(insecure)
    if cfg.get("source") == "laib":
        return LaibPortal(cfg["chain_id"], insecure)
    if cfg.get("source") == "bina":
        return BinaPortal(cfg["prefix"], insecure)
    return CerberusPortal(cfg["user"], insecure)


# ---------------------------------------------------------------------------
# קובץ הסניפים
# ---------------------------------------------------------------------------
def store_category(store_key, store_type, cfg):
    """מחזיר את קטגוריית הסניף: regular / neighborhood / online / excluded."""
    if store_key in cfg.get("excluded", ()):
        return "excluded"
    if store_type == STORE_TYPE_ONLINE:
        return "online"
    limit = cfg.get("neighborhood_from")
    if store_key in cfg.get("neighborhood", ()):
        return "neighborhood"
    if limit and int(store_key.split("-")[-1]) >= limit:
        return "neighborhood"
    return "regular"


CITIES_FILE = Path(__file__).with_name("cities.json")   # קוד למ"ס -> שם יישוב (מ-data.gov.il)
_cities = None
_by_norm = None


def city_lookup():
    """dict: שם מנורמל (כולל כינויים) -> שם רשמי."""
    global _cities, _by_norm
    if _by_norm is None:
        _cities = json.loads(CITIES_FILE.read_text(encoding="utf-8")) if CITIES_FILE.exists() else {}
        _by_norm = {norm_city(n): n for n in _cities.values()}
        for alias, official in CITY_ALIASES.items():
            _by_norm[norm_city(alias)] = official
    return _by_norm


def resolve_city(city_field, name, address, key, cfg):
    """
    שם העיר של סניף. לפי הסדר:
      1. city_overrides בהגדרות הרשת
      2. קוד למ"ס בשדה City (רוב הרשתות)
      3. שם עיר בשדה City (חלק מהרשתות כותבות שם)
      4. שם עיר שמופיע בשם הסניף או בכתובת (יוחננוף לא ממלאת City)
    מחזיר "" אם לא נמצא.
    """
    by_norm = city_lookup()
    if key in cfg.get("city_overrides", {}):
        return cfg["city_overrides"][key]
    field = (city_field or "").strip()
    if field.isdigit() and field.lstrip("0") in _cities:
        return _cities[field.lstrip("0")]
    if field and not field.isdigit() and norm_city(field) in by_norm:
        return by_norm[norm_city(field)]
    # קודם בשם הסניף ורק אז בכתובת ("רמלה", כתובת "שדרות ירושלים" -> רמלה).
    # הארוך קודם: "קרית גת" לפני "גת". מילים נפוצות שהן גם שם יישוב לא נחשבות.
    for text, stop in ((norm_city(name), NAME_STOPLIST), (norm_city(address), ADDRESS_STOPLIST)):
        text = " %s " % text
        for n in sorted(by_norm, key=len, reverse=True):
            if len(n) >= 3 and n not in stop and (" %s " % n) in text:
                return by_norm[n]
    return ""


# שמות יישובים שהם גם מילים רגילות ("אזור התעשיה", "יגאל אלון", "רחוב", "שדרות ירושלים").
# בשם הסניף "שדרות" כן מתכוון לעיר ("יש חסד שדרות"), ובכתובת כמעט אף פעם לא.
NAME_STOPLIST = {"אזור", "מרכז", "רחוב"}
ADDRESS_STOPLIST = NAME_STOPLIST | {"אלון", "שדרות", "צומת", "נוף", "גן", "שער", "שדות"}


def parse_stores(data, cfg):
    """מחזיר dict: מזהה סניף ("תת-רשת-סניף") -> {name, address, city, category}."""
    stores = {}
    for xml_bytes in unpack_to_xml_list(data):
        sub_chain = None
        for _event, el in ET.iterparse(io.StringIO(decode_xml(xml_bytes)), events=("end",)):
            tag = local_tag(el.tag)
            if tag == "subchainid":
                sub_chain = norm_sub_chain(el.text)
            elif tag == "store":
                f = {local_tag(c.tag): (c.text or "").strip() for c in el}
                key = "%s-%s" % (sub_chain or "1", norm_id(f.get("storeid")))
                if cfg.get("sub_chains") and (sub_chain or "1") not in cfg["sub_chains"]:
                    el.clear()
                    continue                 # תת-רשת אחרת (למשל שופרסל דיל, כשרוצים רק יש חסד)
                stores[key] = {"name": f.get("storename", ""),
                               "address": f.get("address", ""),
                               "city": f.get("city", ""),
                               "city_name": resolve_city(f.get("city"), f.get("storename"),
                                                         f.get("address"), key, cfg),
                               "category": store_category(key, f.get("storetype", ""), cfg)}
                el.clear()
    return stores


def latest_stores_file(files):
    found = [(m.group(2) + m.group(3).ljust(6, "0"), f)
             for f in files for m in [STORES_RE.match(f)] if m]
    return max(found)[1] if found else None


def latest_pricefull_per_store(files):
    """מחזיר dict: מזהה סניף -> שם הקובץ העדכני ביותר."""
    best = {}
    for f in files:
        m = PRICEFULL_RE.match(f)
        if not m:
            continue
        _chain_id, sub, store, day, hhmm = m.groups()
        key = "%s-%s" % (norm_sub_chain(sub), norm_id(store))
        stamp = day + hhmm.ljust(6, "0")
        if key not in best or stamp > best[key][0]:
            best[key] = (stamp, f)
    return {k: v[1] for k, v in best.items()}


def city_matches(store_city, wanted):
    wanted = wanted.strip()
    code = CITY_CODES.get(wanted, wanted)
    return store_city.strip() in (code, wanted)


def write_stores_filter(chain, store_ids):
    """ממזג את רשימת הסניפים לתוך stores_filter.json בלי לדרוס רשתות אחרות."""
    current = {}
    if STORES_FILTER_FILE.exists():
        current = json.loads(STORES_FILTER_FILE.read_text(encoding="utf-8"))
    current[chain] = sorted(store_ids)
    STORES_FILTER_FILE.write_text(json.dumps(current, ensure_ascii=False, indent=1),
                                  encoding="utf-8")


# ---------------------------------------------------------------------------
def fetch_chain(chain, cfg, args):
    print("=== %s ===" % chain)
    source = make_source(cfg, args.insecure)
    source.login()

    # 1. סניפים
    stores = {}
    stores_name, stores_data = source.stores_file()
    if stores_name:
        stores = parse_stores(stores_data, cfg)
        Path("stores_%s.json" % chain).write_text(
            json.dumps(stores, ensure_ascii=False, indent=1), encoding="utf-8")
        counts = {c: sum(1 for s in stores.values() if s["category"] == c) for c in CATEGORIES}
        print("קובץ סניפים: %s (%d סניפים: %d רגילים, %d שכונתיים, %d אינטרנט, %d מוחרגים)" % (
            stores_name, len(stores), counts["regular"], counts["neighborhood"],
            counts["online"], counts["excluded"]))
    else:
        print("אזהרה: לא נמצא קובץ סניפים")

    # 2. אילו סניפים רוצים
    if not stores:
        if args.category != "all" or cfg.get("source") == "shufersal":
            sys.exit("אין קובץ סניפים, ולכן אי אפשר לבחור סניפים. הרץ עם --category all")
        wanted = None                                   # כל מה שיש בפורטל
    elif args.category == "all":
        wanted = {k for k, s in stores.items() if s["category"] != "excluded"}
    else:
        wanted = {k for k, s in stores.items() if s["category"] == args.category}
        print("קטגוריה %s: %d סניפים" % (args.category, len(wanted)))

    if args.city:
        in_city = {k for k, s in stores.items() if city_matches(s["city"], args.city)}
        if not in_city:
            sys.exit("לא נמצאו סניפים בעיר '%s'." % args.city)
        wanted = in_city if wanted is None else wanted & in_city
        write_stores_filter(chain, in_city)
        print("סינון לעיר %s: %d סניפים (נכתב %s)" % (args.city, len(wanted), STORES_FILTER_FILE))

    if args.limit and wanted is not None:
        wanted = set(sorted(wanted)[:args.limit])

    # 3. קבצי המחירים
    targets = source.pricefull_files(wanted)
    if args.limit:
        targets = dict(sorted(targets.items())[:args.limit])
    if wanted is not None:
        missing = sorted(wanted - set(targets))
        if missing:
            print("אזהרה: אין קובץ PriceFull ל-%d סניפים: %s" % (len(missing), ", ".join(missing)))

    # 4. הורדה
    out_dir = RAW_DIR / chain
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.iterdir():
        if old.is_file() and "pricefull" in old.name.lower():
            old.unlink()

    ok, failed, total_bytes = 0, [], 0
    for i, (key, fname) in enumerate(sorted(targets.items()), 1):
        for attempt in (1, 2):
            try:
                data = source.download(fname)
                if data[:1] == b"<" and b"<html" in data[:500].lower():
                    raise RuntimeError("התקבל דף HTML במקום קובץ (פג תוקף ההתחברות?)")
                (out_dir / fname).write_bytes(data)
                ok += 1
                total_bytes += len(data)
                print("  [%d/%d] %-8s %s (%.1f MB)" % (i, len(targets), key, fname, len(data) / 1e6))
                break
            except Exception as e:
                if attempt == 1:
                    time.sleep(3)
                    source.login()
                else:
                    failed.append(key)
                    print("  [%d/%d] %-8s נכשל: %s" % (i, len(targets), key, e))
        time.sleep(DOWNLOAD_PAUSE)

    print("הורדו %d קבצים (%.0f MB), נכשלו %d%s" % (
        ok, total_bytes / 1e6, len(failed), (": " + ", ".join(failed)) if failed else ""))
    return not failed


def main():
    ap = argparse.ArgumentParser(description="מוריד קבצי PriceFull מהפורטל המשותף")
    ap.add_argument("--chain", choices=sorted(CHAINS), action="append",
                    help="רשת להורדה (אפשר כמה פעמים). ברירת מחדל: כל הרשתות בטבלה")
    ap.add_argument("--skip", choices=sorted(CHAINS), action="append",
                    help="רשת לדלג עליה (למשל victory ב-GitHub Actions, שאין לו גישה מחו\"ל)")
    ap.add_argument("--category", choices=CATEGORIES + ("all",), default="regular",
                    help="איזה סניפים להוריד (ברירת מחדל: regular = רגילים בלבד)")
    ap.add_argument("--city", help="רק סניפים בעיר הזו (שם או קוד למ\"ס)")
    ap.add_argument("--limit", type=int, help="רק N סניפים ראשונים (לבדיקה)")
    ap.add_argument("--insecure", action="store_true", help="לא לאמת תעודת SSL")
    ap.add_argument("--build", action="store_true", help="להריץ build_prices.py בסוף")
    args = ap.parse_args()

    if not args.city and STORES_FILTER_FILE.exists():
        print("שים לב: קיים %s מהרצה קודמת, ו-build_prices.py יסנן לפיו." % STORES_FILTER_FILE)

    all_ok = True
    skip = set(args.skip or [])
    for chain in args.chain or sorted(CHAINS):
        if chain in skip:
            print("=== %s === דילוג (--skip)" % chain)
            continue
        try:
            all_ok &= fetch_chain(chain, CHAINS[chain], args)
        except Exception as e:
            # רשת אחת שנכשלה לא עוצרת את השאר. הקבצים של הרשת מהפעם הקודמת (אם יש) נשארים.
            print("=== %s === נכשל: %s" % (chain, e))
            all_ok = False

    if args.build:
        import build_prices
        sys.argv = [sys.argv[0]]
        build_prices.main()

    if not all_ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
