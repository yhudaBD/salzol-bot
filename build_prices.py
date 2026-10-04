#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_prices.py  -  שלב 1 בפרויקט בוט המחירים

מה הסקריפט עושה:
  1. קורא קבצי "מחירים מלאים" (PriceFull) שהורדת מאתרי הרשתות.
  2. מוציא מכל קובץ: ברקוד, שם מוצר, יצרן ומחיר.
  3. מחבר את המידע מכל הרשתות והסניפים.
  4. שומר רק את המוצרים הנפוצים ביותר (כי הבוט צריך קובץ קטן ומהיר).
  5. כותב קובץ JSON אחד: docs/prices.json

איך מפעילים:
  מבנה תיקיות:
      raw/
        rami_levy/    <- כאן שמים את קבצי PriceFull של רמי לוי (gz / zip / xml)
        shufersal/    <- וכאן של שופרסל, וכן הלאה
  ואז:
      python build_prices.py

  לראות איך זה עובד בלי נתונים אמיתיים (נתוני דמו בדויים!):
      python build_prices.py --demo

הסקריפט משתמש רק בספרייה הסטנדרטית של פייתון. אין מה להתקין.

את הקבצים מורידים עם fetch_prices.py (או: python fetch_prices.py --build).
"""

import argparse
import codecs
import gzip
import io
import json
import re
import statistics
import sys
import zipfile
from collections import defaultdict
from datetime import date
from pathlib import Path
import xml.etree.ElementTree as ET

# ---------------------------------------------------------------------------
# הגדרות שאפשר לשנות
# ---------------------------------------------------------------------------
RAW_DIR = Path("raw")                  # תיקיית הקבצים שהורדו
OUT_FILE = Path("docs/prices.json")    # קובץ התוצאה (תיקיית docs מתאימה ל-GitHub Pages)
STORES_FILTER_FILE = Path("stores_filter.json")  # אופציונלי, ראו הסבר למטה
MAX_ITEMS = 10000                      # כמה מוצרים לשמור (3000 חתך מוצרי יסוד כמו ביצים)
MIN_COVERAGE = 0.3                     # מוצר חייב להימצא לפחות ב-30% מהסניפים של רשת כלשהי
MIN_BARCODE_LEN = 8                    # ברקוד אמיתי הוא 8 ספרות ומעלה; קודים קצרים הם קודים פנימיים של רשת


# ---------------------------------------------------------------------------
# קריאת קבצים
# ---------------------------------------------------------------------------
def local_tag(tag):
    """מחזיר את שם התג באותיות קטנות, בלי namespace. כך 'ItemPrice' ו-'itemprice' זהים."""
    return tag.rsplit("}", 1)[-1].lower()


def unpack_to_xml_list(data):
    """
    מקבל תוכן של קובץ (בבתים) ומחזיר רשימת תכנים של XML.
    מזהה לפי תוכן הקובץ ולא לפי הסיומת, כי רשתות לפעמים קוראות לקובץ
    zip בשם .gz או ההפך.
    """
    if data[:2] == b"\x1f\x8b":                     # gzip
        return unpack_to_xml_list(gzip.decompress(data))
    if data[:2] == b"PK":                           # zip
        out = []
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for name in z.namelist():
                out.extend(unpack_to_xml_list(z.read(name)))
        return out
    if data[:2] in (codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE):   # UTF-16 עם BOM
        return [data]
    stripped = data.lstrip(codecs.BOM_UTF8 + b" \r\n\t")        # מסיר BOM ורווחים בתחילת הקובץ
    if stripped.startswith(b"<"):                                # נראה כמו XML
        return [stripped]
    return []


def decode_xml(data):
    """מפענח בתים לטקסט: BOM ראשון, אחר כך UTF-8, ובסוף windows-1255 (עברית ישנה)."""
    if data[:2] in (codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE):
        return data.decode("utf-16")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("cp1255", errors="replace")


UNKNOWN_BRANDS = ("לא ידוע", "כללי", "-", "unknown")


def clean_name(name):
    """מסיר תוספות שיווקיות מהשם, כמו "*מבצע*" ביוחננוף, ורווחים כפולים."""
    name = re.sub(r"\*[^*]{0,12}\*", " ", name)
    return re.sub(r"\s+", " ", name).strip()


def norm_sub_chain(text):
    """
    "001" -> "1". תת-רשת 0 נחשבת כמו 1: יוחננוף כותבת 000 בקבצי המחירים
    ו-001 בקובץ הסניפים, ובשתיהן הכוונה לרשת הראשית.
    """
    s = (text or "").strip().lstrip("0")
    return s or "1"


def parse_price_xml(xml_bytes):
    """
    קורא קובץ מחירים אחד (של סניף אחד).
    מחזיר: (מזהה_סניף, רשימת מוצרים).
    מזהה הסניף הוא "תת-רשת-סניף" (SubChainId-StoreId), כי אותו מספר סניף
    יכול להופיע בתתי-רשתות שונות של אותה רשת.
    כל מוצר: dict עם code, name, brand, price.
    """
    text = decode_xml(xml_bytes)
    store_id = None
    sub_chain = None
    items = []
    for _event, el in ET.iterparse(io.StringIO(text), events=("end",)):
        tag = local_tag(el.tag)

        if tag == "storeid" and store_id is None:
            store_id = (el.text or "").strip().lstrip("0") or "0"

        elif tag == "subchainid" and sub_chain is None:
            sub_chain = norm_sub_chain(el.text)

        elif tag in ("item", "product"):
            fields = {local_tag(c.tag): (c.text or "").strip() for c in el}
            code = fields.get("itemcode", "")
            name = fields.get("itemname") or fields.get("itemnm") or ""
            # ברשתות מסוימות השם קטוע ל-20 תווים, והתיאור לפעמים מלא יותר
            desc = (fields.get("manufactureritemdescription")
                    or fields.get("manufactureitemdescription") or "")
            if len(desc) > len(name) and desc.startswith(name[:10]):
                name = desc
            brand = fields.get("manufacturername") or fields.get("manufacturename") or ""
            weighted = fields.get("bisweighted", "0").lower() in ("1", "true")
            try:
                price = float(fields.get("itemprice", ""))
            except ValueError:
                price = 0.0

            if (code.isdigit() and len(code) >= MIN_BARCODE_LEN and name
                    and price > 0 and not weighted):
                items.append({"code": code, "name": clean_name(name), "brand": brand, "price": price})
            el.clear()                               # חוסך זיכרון בקבצים גדולים

    store_key = "%s-%s" % (sub_chain, store_id) if sub_chain else (store_id or "unknown")
    return store_key, items


def load_stores_filter():
    """
    קובץ אופציונלי stores_filter.json שמגביל לסניפים מסוימים (למשל רק סניפים בבני ברק):
        {"rami_levy": ["1-12", "1-45"], "shufersal": ["1-301"]}
    כל מזהה הוא "תת-רשת-סניף" (למשל 1-12), בדיוק כמו שמופיע בקובץ המחירים.
    בלי הקובץ, הסקריפט משתמש בכל הסניפים.
    """
    if STORES_FILTER_FILE.exists():
        raw = json.loads(STORES_FILTER_FILE.read_text(encoding="utf-8"))
        return {chain: set(stores) for chain, stores in raw.items()}
    return {}


def collect(raw_dir, stores_filter):
    """
    עובר על כל התיקיות בתוך raw/ (תיקייה = רשת) ואוסף את כל המחירים.
    מחזיר:
        prices[barcode][chain][store_id] = מחיר
        info[barcode] = {"n": שם, "b": יצרן}
        stores_per_chain[chain] = קבוצת סניפים שנקראו
    """
    prices = defaultdict(lambda: defaultdict(dict))
    info = {}
    stores_per_chain = defaultdict(set)

    chain_dirs = [d for d in sorted(raw_dir.iterdir()) if d.is_dir()]
    if not chain_dirs:
        sys.exit("לא נמצאו תיקיות רשתות בתוך '%s'. צור תיקייה לכל רשת, למשל raw/rami_levy" % raw_dir)

    for chain_dir in chain_dirs:
        chain = chain_dir.name
        allowed = stores_filter.get(chain)           # None = כל הסניפים
        files = [f for f in sorted(chain_dir.iterdir())
                 if f.is_file() and "pricefull" in f.name.lower()]
        print("רשת %-14s נמצאו %d קבצי PriceFull" % (chain, len(files)))

        for f in files:
            try:
                xml_list = unpack_to_xml_list(f.read_bytes())
            except Exception as e:
                print("   דילוג על %s (לא ניתן לפתוח: %s)" % (f.name, e))
                continue

            for xml_bytes in xml_list:
                try:
                    store_id, items = parse_price_xml(xml_bytes)
                except ET.ParseError as e:
                    print("   דילוג על %s (XML לא תקין: %s)" % (f.name, e))
                    continue
                if allowed is not None and store_id not in allowed:
                    continue
                stores_per_chain[chain].add(store_id)
                for it in items:
                    prices[it["code"]][chain][store_id] = it["price"]
                    # אותו ברקוד מופיע בכמה רשתות. שומרים את השם הארוך ביותר
                    # (רמי לוי קוטעת ל-20 תווים), ויצרן אמיתי במקום "לא ידוע".
                    cur = info.get(it["code"])
                    if cur is None:
                        info[it["code"]] = {"n": it["name"], "b": it["brand"]}
                    else:
                        if len(it["name"]) > len(cur["n"]):
                            cur["n"] = it["name"]
                        if it["brand"] and (not cur["b"] or cur["b"] in UNKNOWN_BRANDS):
                            cur["b"] = it["brand"]

    return prices, info, stores_per_chain


# ---------------------------------------------------------------------------
# בחירת המוצרים הנפוצים ובניית התוצאה
# ---------------------------------------------------------------------------
def build_output(prices, info, stores_per_chain, max_items, min_coverage):
    """
    לכל מוצר מחשבים "כמה נפוץ" הוא:
      - באיזה כמות רשתות הוא נמצא (חשוב להשוואה בין רשתות)
      - בכמה אחוז מהסניפים של כל רשת
    מוצרים נדירים נזרקים. את השאר ממיינים ושומרים את max_items הראשונים.
    המחיר שנשמר לכל רשת הוא החציוני בין הסניפים (המחיר ה"טיפוסי").
    """
    ranked = []
    for code, by_chain in prices.items():
        coverages = {}
        for chain, by_store in by_chain.items():
            total = len(stores_per_chain[chain]) or 1
            coverages[chain] = len(by_store) / total
        if max(coverages.values()) < min_coverage:
            continue                                  # מוצר נדיר, לא שומרים
        score = (len(by_chain), sum(coverages.values()) / len(coverages))
        ranked.append((score, code))

    ranked.sort(reverse=True)
    kept = ranked[:max_items]

    items = {}
    for _score, code in kept:
        typical = {}
        for chain, by_store in prices[code].items():
            typical[chain] = round(statistics.median(by_store.values()), 2)
        items[code] = {"n": info[code]["n"], "b": info[code]["b"], "p": typical}

    return {
        "updated": date.today().isoformat(),
        "chains": {c: len(s) for c, s in stores_per_chain.items()},
        "items": items,
    }


def print_spread(prices, kept_codes):
    """
    כמה המחירים שונים בין סניפים של אותה רשת (רק למוצרים שנשמרו).
    עוזר להחליט אם צריך התאמה לפי עיר, או שמחיר חציוני לרשת מספיק.
    """
    for chain in sorted({c for code in kept_codes for c in prices[code]}):
        gaps = []
        for code in kept_codes:
            by_store = prices[code].get(chain)
            if by_store and len(by_store) > 1:
                lo, hi = min(by_store.values()), max(by_store.values())
                med = statistics.median(by_store.values())
                gaps.append((hi - lo) / med)
        if not gaps:
            continue
        same = sum(1 for g in gaps if g == 0) / len(gaps)
        print("פיזור מחירים בין סניפים, %s (%d מוצרים):" % (chain, len(gaps)))
        print("   מחיר זהה בכל הסניפים: %.0f%%" % (same * 100))
        print("   פער ממוצע בין הזול ליקר: %.1f%%, פער מקסימלי: %.0f%%" % (
            statistics.mean(gaps) * 100, max(gaps) * 100))
        print("   מוצרים עם פער מעל 10%%: %d" % sum(1 for g in gaps if g > 0.10))


def print_sample(result, n, seed=None):
    """מדפיס n מוצרים אקראיים לבדיקה ידנית מול אתר הרשת."""
    import random
    codes = list(result["items"])
    rnd = random.Random(seed)
    print("\n%d מוצרים אקראיים לבדיקה ידנית מול אתר הרשת:" % min(n, len(codes)))
    for code in sorted(rnd.sample(codes, min(n, len(codes)))):
        it = result["items"][code]
        prices = ", ".join("%s %.2f" % (c, p) for c, p in sorted(it["p"].items()))
        print("   %s  %s (%s)  ->  %s" % (code, it["n"], it["b"], prices))


# ---------------------------------------------------------------------------
# נתוני דמו (בדויים, רק כדי לראות שהסקריפט עובד)
# ---------------------------------------------------------------------------
DEMO_XML = """<?xml version="1.0" encoding="utf-8"?>
<Root>
  <ChainId>7290000000000</ChainId>
  <SubChainId>001</SubChainId>
  <StoreId>{store}</StoreId>
  <Items Count="{count}">
{items}
  </Items>
</Root>"""

DEMO_ITEM = """    <Item>
      <ItemCode>{code}</ItemCode>
      <ItemName>{name}</ItemName>
      <ManufacturerName>{brand}</ManufacturerName>
      <ItemPrice>{price}</ItemPrice>
      <bIsWeighted>{weighted}</bIsWeighted>
    </Item>"""

DEMO_PRODUCTS = [  # (ברקוד, שם, יצרן, מחיר, [שקול])
    ("7290000000011", "פסטה 500 גרם (דמו)", "מותג א", 5.9),
    ("7290000000028", "ביצים L 12 יחידות (דמו)", "מותג ב", 14.5),
    ("7290000000035", "לחם פרוס (דמו)", "מותג ג", 7.9),
    ("7290000000042", "שמן קנולה 1 ליטר (דמו)", "מותג ד", 12.9),
    ("12345", "קוד פנימי קצר שלא אמור להיכנס", "-", 1.0),
    ("7290000000059", "מוצר במשקל שלא אמור להיכנס (דמו)", "-", 30.0, 1),
]


def make_demo(raw_dir):
    """יוצר תיקיות raw_demo עם 2 רשתות בדויות ו-2 סניפים לכל אחת."""
    factors = {"chain_a": 1.00, "chain_b": 1.08}
    for chain, factor in factors.items():
        d = raw_dir / chain
        d.mkdir(parents=True, exist_ok=True)
        for store, extra in (("001", 0.0), ("002", 0.2)):
            items = "\n".join(
                DEMO_ITEM.format(code=prod[0], name=prod[1], brand=prod[2],
                                 price=round(prod[3] * factor + extra, 2),
                                 weighted=prod[4] if len(prod) > 4 else 0)
                for prod in DEMO_PRODUCTS
            )
            xml = DEMO_XML.format(store=store, count=len(DEMO_PRODUCTS), items=items)
            (d / ("PriceFull7290000000000-%s-20260101.gz" % store)).write_bytes(
                gzip.compress(xml.encode("utf-8")))


# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="בונה קובץ מחירים קטן מקבצי PriceFull של רשתות")
    ap.add_argument("--demo", action="store_true", help="הרצה על נתוני דמו בדויים")
    ap.add_argument("--raw", default=str(RAW_DIR), help="תיקיית הקבצים (ברירת מחדל: raw)")
    ap.add_argument("--out", default=str(OUT_FILE), help="קובץ התוצאה")
    ap.add_argument("--max-items", type=int, default=MAX_ITEMS)
    ap.add_argument("--min-coverage", type=float, default=MIN_COVERAGE)
    ap.add_argument("--sample", type=int, default=0,
                    help="להדפיס N מוצרים אקראיים לבדיקה ידנית")
    args = ap.parse_args()

    raw_dir = Path(args.raw)
    out_file = Path(args.out)
    stores_filter = load_stores_filter()

    if args.demo:
        raw_dir = Path("raw_demo")
        out_file = Path("demo_prices.json")
        make_demo(raw_dir)
        stores_filter = {}
        print("*** מצב דמו: הנתונים בדויים ***")

    if not raw_dir.exists():
        sys.exit("התיקייה '%s' לא קיימת. ראה הוראות בראש הקובץ." % raw_dir)

    prices, info, stores_per_chain = collect(raw_dir, stores_filter)
    result = build_output(prices, info, stores_per_chain, args.max_items, args.min_coverage)

    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_text(
        json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    size_kb = out_file.stat().st_size / 1024
    print("\nנשמרו %d מוצרים ל-%s (%.0f KB)" % (len(result["items"]), out_file, size_kb))
    print("סניפים שנקראו לכל רשת:", result["chains"])
    print_spread(prices, list(result["items"]))
    if args.sample:
        print_sample(result, args.sample)


if __name__ == "__main__":
    main()
