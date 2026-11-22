"""Check the same retailer domains as the Findora link manager."""

import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


AMAZON = {"amazon.de", "amazon.com", "amazon.co.uk", "amzn.to", "amzn.eu"}
RETAILERS = AMAZON | {"ikea.de", "ikea.com", "shein.com", "temu.com", "otto.de", "ebay.de", "ebay.com", "etsy.com", "wayfair.de", "home24.de"}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_):
        return None


def allowed(url, domains):
    parsed = urlsplit(url)
    ports = {"https": 443, "http": 80}
    return (parsed.scheme in ports and parsed.port in (None, ports[parsed.scheme]) and not parsed.username
            and parsed.password is None and (parsed.hostname or "").removeprefix("www.") in domains)


def canonical(url):
    if not allowed(url, AMAZON):
        return ""
    parsed = urlsplit(url)
    match = re.search(r"/(?:dp|gp/product|gp/aw/d)/([A-Z0-9]{10})(?:/|$)", parsed.path, re.I)
    args = {key.lower(): values for key, values in parse_qs(parsed.query).items()}
    asin = match[1] if match else args.get("asin", [""])[0]
    return f"https://www.amazon.de/dp/{asin.upper()}" if re.fullmatch(r"[A-Z0-9]{10}", asin, re.I) else ""


def inspect(item, resolve=False):
    url = item["url"]
    opener = build_opener(ProxyHandler({}), NoRedirect())
    domains = AMAZON if resolve else RETAILERS
    result = {**item, "status": None, "normal_link": ""}

    def fetch(method):
        request = Request(url, method=method, headers={"Range": "bytes=0-0", "User-Agent": "FindoraHomeLinkManager/1.0"})
        try:
            response = opener.open(request, timeout=3)
        except HTTPError as error:
            response = error
        with response:
            return response.code, response.headers.get("Location")

    try:
        for _ in range(4):
            if not allowed(url, domains):
                return {**result, "state": "unsupported", "reason": "Domain nicht automatisch prüfbar"}
            normal = canonical(url) if resolve else ""
            if normal:
                return {**result, "normal_link": normal, "state": "ok"}
            code, location = fetch("HEAD")
            if code in (403, 405):
                code, location = fetch("GET")
            if 300 <= code < 400 and location:
                url = urljoin(url, location)
                continue
            state = "ok" if 200 <= code < 300 else "temporary" if code in (403, 429) or code >= 500 else "broken"
            return {**result, "state": state, "status": code, "reason": None if state == "ok" else f"HTTP {code}"}
    except (ValueError, UnicodeError):
        return {**result, "state": "broken", "reason": "Ungültige URL"}
    except (TimeoutError, URLError, OSError):
        return {**result, "state": "temporary", "reason": "Vorübergehend nicht erreichbar"}
    return {**result, "state": "unsupported", "reason": "Zu viele Weiterleitungen"}


if __name__ == "__main__":
    resolve = sys.argv[1] == "resolve"
    rows = json.loads(sys.argv[2])
    if not isinstance(rows, list) or len(rows) > 12:
        raise ValueError("Expected at most twelve links")
    with ThreadPoolExecutor(max_workers=4) as executor:
        json.dump(list(executor.map(lambda row: inspect(row, resolve), rows)), sys.stdout)
