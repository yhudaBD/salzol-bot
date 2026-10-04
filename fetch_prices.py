#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_prices.py  -  הורדת קבצי מחירים מהפורטל המשותף (url.publishedprices.co.il)

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

from build_prices import (RAW_DIR, STORES_FILTER_FILE, decode_xml, local_tag,
                          unpack_to_xml_list)

# ---------------------------------------------------------------------------
# הגדרות שאפשר לשנות
# ---------------------------------------------------------------------------
PORTAL = "https://url.publishedprices.co.il"

# רשתות בפורטל המשותף: שם התיקייה ב-raw -> שם המשתמש בפורטל.
# כדי להוסיף רשת (שלב 6) מוסיפים כאן שורה.
#   neighborhood_from: מספר סניף שממנו והלאה הסניף "שכונתי" (המחירים בהם יקרים יותר).
#   בקובץ הסניפים אין שדה שמבדיל ביניהם, ולכן מזהים לפי מספר הסניף.
#   neighborhood: סניפים שכונתיים נוספים שהמספר שלהם נמוך מ-neighborhood_from.
#   excluded: סניפים שלא מורידים בכלל (למשל אילת, שבה אין מע"מ והמחירים לא מייצגים).
CHAINS = {
    "rami_levy": {"user": "RamiLevi", "neighborhood_from": 700,
                  "neighborhood": ["1-3"],  # 1-3 = רמות, ירושלים
                  "excluded": ["1-203"]},   # 1-203 = אילת
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
STORES_RE = re.compile(r"^stores(\d+)-.*?(\d{8})-?(\d{4,6})\.", re.IGNORECASE)


def norm_id(s):
    """'001' -> '1'. אותו נרמול כמו ב-parse_price_xml, כדי שמזהי הסניפים יתאימו."""
    return (s or "").strip().lstrip("0") or "0"


# ---------------------------------------------------------------------------
# חיבור לפורטל
# ---------------------------------------------------------------------------
class Portal:
    def __init__(self, user, insecure=False):
        self.user = user
        ctx = ssl.create_default_context()
        if insecure:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
            urllib.request.HTTPSHandler(context=ctx))
        self.opener.addheaders = [("User-Agent", "Mozilla/5.0 (price-bot)")]
        self.token = None

    def _open(self, path, data=None):
        body = urllib.parse.urlencode(data).encode() if data is not None else None
        try:
            return self.opener.open(PORTAL + path, body, timeout=TIMEOUT)
        except urllib.error.URLError as e:
            if isinstance(e.reason, ssl.SSLCertVerificationError):
                sys.exit("אימות תעודת האבטחה של הפורטל נכשל (%s).\n"
                         "אם אתה סומך על הרשת שלך, אפשר להריץ שוב עם --insecure" % e.reason)
            raise

    @staticmethod
    def _csrf(html):
        m = re.search(r'name="csrftoken"\s+content="([^"]+)"', html)
        if not m:
            raise RuntimeError("לא נמצא csrftoken בדף. ייתכן שהפורטל שינה מבנה.")
        return m.group(1)

    def login(self):
        html = self._open("/login").read().decode("utf-8", "replace")
        resp = self._open("/login/user", {
            "r": "", "username": self.user, "password": "",
            "Submit": "Sign in", "csrftoken": self._csrf(html)})
        page = resp.read().decode("utf-8", "replace")
        if "/login" in resp.geturl():
            raise RuntimeError("ההתחברות נכשלה עבור המשתמש '%s'." % self.user)
        self.token = self._csrf(page)       # הדף /file מכיל טוקן חדש לבקשות הבאות

    def list_files(self):
        resp = self._open("/file/json/dir", {
            "sEcho": "1", "iColumns": "5", "iDisplayStart": "0",
            "iDisplayLength": "100000", "cd": "/", "csrftoken": self.token})
        data = json.loads(resp.read().decode("utf-8"))
        return [row["fname"] for row in data.get("aaData", [])]

    def download(self, fname):
        return self._open("/file/d/" + urllib.parse.quote(fname)).read()


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


def parse_stores(data, cfg):
    """מחזיר dict: מזהה סניף ("תת-רשת-סניף") -> {name, address, city, category}."""
    stores = {}
    for xml_bytes in unpack_to_xml_list(data):
        sub_chain = None
        for _event, el in ET.iterparse(io.StringIO(decode_xml(xml_bytes)), events=("end",)):
            tag = local_tag(el.tag)
            if tag == "subchainid":
                sub_chain = norm_id(el.text)
            elif tag == "store":
                f = {local_tag(c.tag): (c.text or "").strip() for c in el}
                key = "%s-%s" % (sub_chain or "1", norm_id(f.get("storeid")))
                stores[key] = {"name": f.get("storename", ""),
                               "address": f.get("address", ""),
                               "city": f.get("city", ""),
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
        key = "%s-%s" % (norm_id(sub or "1"), norm_id(store))
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
    portal = Portal(cfg["user"], insecure=args.insecure)
    portal.login()
    files = portal.list_files()
    print("בפורטל %d קבצים" % len(files))

    # 1. סניפים
    stores = {}
    stores_name = latest_stores_file(files)
    if stores_name:
        stores = parse_stores(portal.download(stores_name), cfg)
        Path("stores_%s.json" % chain).write_text(
            json.dumps(stores, ensure_ascii=False, indent=1), encoding="utf-8")
        counts = {c: sum(1 for s in stores.values() if s["category"] == c) for c in CATEGORIES}
        print("קובץ סניפים: %s (%d סניפים: %d רגילים, %d שכונתיים, %d אינטרנט, %d מוחרגים)" % (
            stores_name, len(stores), counts["regular"], counts["neighborhood"],
            counts["online"], counts["excluded"]))
    else:
        print("אזהרה: לא נמצא קובץ סניפים")

    # 2. בחירת קבצי מחירים
    targets = latest_pricefull_per_store(files)
    missing = sorted(set(stores) - set(targets))
    if missing:
        print("אזהרה: אין קובץ PriceFull ל-%d סניפים: %s" % (len(missing), ", ".join(missing)))

    if args.category == "all":
        excluded = set(cfg.get("excluded", ()))
        targets = {k: v for k, v in targets.items() if k not in excluded}
    else:
        if not stores:
            sys.exit("אין קובץ סניפים, ולכן אי אפשר לסנן לפי קטגוריה. הרץ עם --category all")
        targets = {k: v for k, v in targets.items()
                   if stores.get(k, {}).get("category") == args.category}
        print("קטגוריה %s: %d סניפים" % (args.category, len(targets)))

    if args.city:
        wanted = {k for k, s in stores.items() if city_matches(s["city"], args.city)}
        if not wanted:
            sys.exit("לא נמצאו סניפים בעיר '%s'." % args.city)
        targets = {k: v for k, v in targets.items() if k in wanted}
        write_stores_filter(chain, wanted)
        print("סינון לעיר %s: %d סניפים (נכתב %s)" % (args.city, len(wanted), STORES_FILTER_FILE))

    if args.limit:
        targets = dict(sorted(targets.items())[:args.limit])

    # 3. הורדה
    out_dir = RAW_DIR / chain
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.iterdir():
        if old.is_file() and "pricefull" in old.name.lower():
            old.unlink()

    ok, failed, total_bytes = 0, [], 0
    for i, (key, fname) in enumerate(sorted(targets.items()), 1):
        for attempt in (1, 2):
            try:
                data = portal.download(fname)
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
                    portal.login()
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
    for chain in args.chain or sorted(CHAINS):
        all_ok &= fetch_chain(chain, CHAINS[chain], args)

    if args.build:
        import build_prices
        sys.argv = [sys.argv[0]]
        build_prices.main()

    if not all_ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
