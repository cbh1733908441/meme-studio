#!/usr/bin/env python3
"""Read public product descriptions; no search, media download, or mechanism inference."""

import argparse
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen


class TextOnly(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in {"p", "br", "div", "li", "h1", "h2", "h3"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in {"p", "div", "li", "h1", "h2", "h3"}:
            self.parts.append("\n")

    def handle_data(self, data):
        self.parts.append(data)


def plain(value):
    parser = TextOnly()
    parser.feed(value or "")
    return "\n".join(line.strip() for line in "".join(parser.parts).splitlines() if line.strip())


def product_id(provider, value):
    if re.fullmatch(r"[1-9][0-9]*", value):
        return value
    parsed = urlparse(value)
    expected_host = "store.steampowered.com" if provider == "steam" else "apps.apple.com"
    pattern = r"/app/([1-9][0-9]*)(?:/|$)" if provider == "steam" else r"/id([1-9][0-9]*)(?:/|$)"
    match = re.search(pattern, parsed.path)
    if parsed.scheme == "https" and parsed.hostname == expected_host and match:
        return match.group(1)
    raise ValueError("Use a positive product ID or a matching HTTPS product URL.")


def request_json(url):
    req = Request(url, headers={"User-Agent": "mechanism-evidence/1.0", "Accept": "application/json"})
    with urlopen(req, timeout=25) as response:
        return json.load(response)


def fetch(provider, identifier, country, language):
    pid = product_id(provider, identifier)
    common = {
        "schema_version": 1,
        "status": "ok",
        "provider": provider,
        "product_id": pid,
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "source_kind": "publisher_store_description",
        "gameplay_observed": False,
        "media_inspected": False,
        "country": country,
    }
    if provider == "steam":
        endpoint = "https://store.steampowered.com/api/appdetails?" + urlencode({"appids": pid, "cc": country, "l": language})
        payload = request_json(endpoint)
        if not isinstance(payload, dict):
            raise ValueError("Unexpected Steam response schema.")
        result = payload.get(pid)
        if not isinstance(result, dict) or not result.get("success"):
            raise LookupError("Steam returned no successful product record for this ID/region.")
        d = result.get("data")
        if not isinstance(d, dict):
            raise ValueError("Successful Steam record is missing product data.")
        description = plain(d.get("about_the_game") or d.get("detailed_description", ""))
        common.update({
            "source_url": f"https://store.steampowered.com/app/{pid}/",
            "endpoint_url": endpoint,
            "name": d.get("name"),
            "product_type": d.get("type"),
            "developers": d.get("developers", []),
            "publishers": d.get("publishers", []),
            "platforms": d.get("platforms", {}),
            "release": d.get("release_date", {}),
            "short_description": plain(d.get("short_description")),
            "description": description,
            "website": d.get("website"),
            "screenshots": [s.get("path_full") for s in d.get("screenshots", [])],
            "trailers": [{"id": m.get("id"), "name": m.get("name"), "mp4": m.get("mp4"), "webm": m.get("webm"), "hls_h264": m.get("hls_h264")} for m in d.get("movies", [])],
            "store_recommendation_count": (d.get("recommendations") or {}).get("total"),
            "metacritic": d.get("metacritic"),
            "notes": ["Public Store endpoint; availability and schema may change.", "Platform flags do not establish touch-control suitability."],
        })
        reviews_endpoint = "https://store.steampowered.com/appreviews/" + pid + "?" + urlencode({"json": 1, "language": "all", "purchase_type": "all", "num_per_page": 0})
        try:
            reviews = request_json(reviews_endpoint)
            summary = reviews.get("query_summary", {}) if isinstance(reviews, dict) else {}
            total_reviews = summary.get("total_reviews")
            total_positive = summary.get("total_positive")
            common["reviews_endpoint_url"] = reviews_endpoint
            common["review_summary"] = {
                "review_score": summary.get("review_score"),
                "review_score_desc": summary.get("review_score_desc"),
                "total_positive": total_positive,
                "total_negative": summary.get("total_negative"),
                "total_reviews": total_reviews,
                "positive_percent": round(total_positive * 100 / total_reviews, 1) if isinstance(total_positive, int) and isinstance(total_reviews, int) and total_reviews else None,
            }
        except (ValueError, TypeError, AttributeError, HTTPError, URLError, TimeoutError, OSError) as exc:
            common["notes"].append("Steam review summary unavailable: " + str(exc))
    else:
        endpoint = "https://itunes.apple.com/lookup?" + urlencode({"id": pid, "country": country})
        payload = request_json(endpoint)
        if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
            raise ValueError("Unexpected Apple response schema.")
        results = payload["results"]
        records = [d for d in results if isinstance(d, dict) and str(d.get("trackId")) == pid]
        if not records:
            raise LookupError("Apple returned no matching product in this country; this does not establish global unavailability.")
        d = records[0]
        description = d.get("description", "")
        common.update({
            "source_url": d.get("trackViewUrl") or f"https://apps.apple.com/{country}/app/id{pid}",
            "endpoint_url": endpoint,
            "name": d.get("trackName"),
            "product_type": d.get("kind"),
            "developer": d.get("artistName"),
            "seller": d.get("sellerName"),
            "supported_devices": d.get("supportedDevices", []),
            "features": d.get("features", []),
            "minimum_os_version": d.get("minimumOsVersion"),
            "version": d.get("version"),
            "release_date": d.get("releaseDate"),
            "average_user_rating": d.get("averageUserRating"),
            "user_rating_count": d.get("userRatingCount"),
            "description": description,
            "website": d.get("sellerUrl"),
            "screenshots": d.get("screenshotUrls", []),
            "ipad_screenshots": d.get("ipadScreenshotUrls", []),
            "notes": ["Check supported_devices and the store platform label; App Store includes Mac products."],
        })
    common["description_sha256"] = hashlib.sha256(description.encode("utf-8")).hexdigest()
    if not description.strip():
        common["notes"].append("No description returned; mechanism evidence remains missing.")
    return common


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("provider", choices=["steam", "apple"])
    parser.add_argument("identifier", help="Product ID or canonical store URL")
    parser.add_argument("--country", default="us")
    parser.add_argument("--language", default="english", help="Steam language")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        if not re.fullmatch(r"[a-zA-Z]{2}", args.country):
            raise ValueError("country must be a two-letter country code")
        result = fetch(args.provider, args.identifier, args.country.lower(), args.language)
    except (ValueError, LookupError, TypeError, AttributeError, HTTPError, URLError, TimeoutError, OSError) as exc:
        result = {"schema_version": 1, "status": "error", "provider": args.provider, "identifier": args.identifier, "retrieved_at": datetime.now(timezone.utc).isoformat(), "error_type": type(exc).__name__, "error": str(exc), "gameplay_observed": False}
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload + "\n", encoding="utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print(payload)
    return 0 if result["status"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
