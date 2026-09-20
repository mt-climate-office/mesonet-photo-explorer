#!/usr/bin/env python3
"""
Generate docs/preview.png by loading the live GitHub Pages site with
?export=dark and intercepting the PNG download that the export button triggers.

The resulting image is committed to docs/ and used as the og:image social
preview for the GitHub Pages site.

Usage:
    pip install playwright
    playwright install --with-deps chromium
    python scripts/generate_preview.py
"""

import shutil
from pathlib import Path

from playwright.sync_api import sync_playwright

DOCS = Path(__file__).parent.parent / "docs"
OUT  = DOCS / "preview.png"
# The Pages origin, loaded directly, so regenerating the card does not depend
# on the UMT reverse proxy that serves the canonical mesonet.climate.umt.edu/photos/.
URL  = "https://mt-climate-office.github.io/mesonet-photo-explorer/"


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(
            viewport={"width": 1400, "height": 700},
            accept_downloads=True,
            color_scheme="dark",   # match the app's default dark theme
        )
        page = ctx.new_page()

        # Surface any JS errors or console warnings to stdout for debugging.
        page.on("console", lambda msg: print(f"  [{msg.type}] {msg.text}") if msg.type != "log" else None)
        page.on("pageerror", lambda err: print(f"  [pageerror] {err}"))

        # ?export=dark triggers btn-export.click() after a 4-second delay that
        # allows map data to load.  page.expect_download() is the correct
        # page-level API for intercepting downloads in Playwright.
        print(f"Loading {URL}?export=dark and waiting for export download…")
        with page.expect_download(timeout=60_000) as dl:
            page.goto(
                f"{URL}?export=dark",
                wait_until="domcontentloaded",
                timeout=30_000,
            )

        tmp = dl.value.path()
        if not tmp:
            raise RuntimeError("Download completed but no file path was returned.")
        shutil.copy(tmp, OUT)
        print(f"Preview saved → {OUT}")

        browser.close()


if __name__ == "__main__":
    main()
