"""Package Chromium and Firefox extension archives into Extensions/dist/."""

import os
import zipfile


EXT_DIR = os.path.dirname(os.path.abspath(__file__))
DIST_DIR = os.path.join(EXT_DIR, "dist")
SHARED_FILES = ["background.js", "content.js"]


def build_archive(zip_name, manifest_source):
    """Write a clean browser extension .zip with manifest.json at the archive root."""
    os.makedirs(DIST_DIR, exist_ok=True)
    out_path = os.path.join(DIST_DIR, zip_name)

    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.write(os.path.join(EXT_DIR, manifest_source), arcname="manifest.json")
        for rel_file in SHARED_FILES:
            zf.write(os.path.join(EXT_DIR, rel_file), arcname=rel_file)

        icons_dir = os.path.join(EXT_DIR, "icons")
        if os.path.isdir(icons_dir):
            for entry in sorted(os.listdir(icons_dir)):
                abs_icon = os.path.join(icons_dir, entry)
                if os.path.isfile(abs_icon):
                    zf.write(abs_icon, arcname=f"icons/{entry}")

    return out_path


if __name__ == "__main__":
    firefox_zip = build_archive("tsw6ti-connector-firefox.zip", "manifest.firefox.json")
    chromium_zip = build_archive("tsw6ti-connector-chromium.zip", "manifest.json")
    print(f"Built Firefox package:  {firefox_zip}")
    print(f"Built Chromium package: {chromium_zip}")

