# SPDX-License-Identifier: GPL-3.0-or-later
"""Validate a built Mobile release and print its immutable tag without changing it."""

import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import zipfile


PLUGIN = "uk.co.protonn.secure-messaging"
PLUGIN_ZIP = f"{PLUGIN}.zip"
CHECKSUM_FILES = {PLUGIN_ZIP, "revenge-runtime-source.zip", "revenge.bundle"}
ASSETS = CHECKSUM_FILES | {
    "REVENGE-LICENSE", "SHA256SUMS", "desktop-commit.txt", "index.json", "toolchain.json"
}
SOURCE = Path(__file__).resolve().parents[1]
MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_JSON_BYTES = 64 * 1024


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON field: {key}")
        result[key] = value
    return result


def invalid_constant(value):
    raise ValueError(f"Invalid JSON constant: {value}")


def read_json(data):
    if len(data) > MAX_JSON_BYTES:
        raise ValueError("Release JSON exceeds its size limit")
    return json.loads(data.decode("utf-8"), object_pairs_hook=unique_object, parse_constant=invalid_constant)


def same_json(left, right):
    # Python considers True == 1; release metadata must preserve JSON value types.
    return json.dumps(left, sort_keys=True) == json.dumps(right, sort_keys=True)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def positive_integer(value):
    require(isinstance(value, str) and re.fullmatch(r"[1-9][0-9]{0,18}", value),
            "Release context requires positive numeric run identifiers")
    return int(value)


def validate_release(directory, context):
    repository = context.get("GITHUB_REPOSITORY", "")
    commit = context.get("GITHUB_SHA", "")
    require(re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*/[A-Za-z0-9_-][A-Za-z0-9_.-]*", repository),
            "Invalid release repository")
    require(re.fullmatch(r"[a-f0-9]{40}", commit), "Invalid release commit")
    run_id = positive_integer(context.get("GITHUB_RUN_ID"))
    run_number = positive_integer(context.get("GITHUB_RUN_NUMBER"))
    current_attempt = positive_integer(context.get("GITHUB_RUN_ATTEMPT"))

    directory = Path(directory)
    require({path.name for path in directory.iterdir()} == ASSETS,
            "Expected exactly the eight Mobile release assets")
    assets = {}
    for name in ASSETS:
        path = directory / name
        require(not path.is_symlink() and path.is_file(), f"Invalid release file: {name}")
        require(0 < path.stat().st_size <= MAX_FILE_BYTES, f"Invalid release size: {name}")
        with path.open("rb") as stream:
            assets[name] = stream.read(MAX_FILE_BYTES + 1)
        require(len(assets[name]) <= MAX_FILE_BYTES, f"Release file grew beyond its limit: {name}")

    require(assets["desktop-commit.txt"] == f"{commit}\n".encode(),
            "Mobile build belongs to a different desktop commit")
    require(same_json(read_json(assets["toolchain.json"]), read_json((SOURCE / "toolchain.json").read_bytes())),
            "Mobile build toolchain does not match this revision")

    index = read_json(assets["index.json"])
    require(isinstance(index, dict) and isinstance(index.get("plugins"), dict)
            and set(index["plugins"]) == {PLUGIN}, "Invalid Mobile plugin index")
    plugin = index["plugins"][PLUGIN]
    require(isinstance(plugin, dict) and isinstance(plugin.get("versions"), dict)
            and len(plugin["versions"]) == 1, "Expected exactly one Mobile plugin version")
    version = next(iter(plugin["versions"]))
    match = re.fullmatch(rf"0\.2\.{run_number}\.([1-9][0-9]{{0,18}})-nightly", version)
    require(match is not None, "Mobile version belongs to a different workflow run")
    build_attempt = int(match[1])
    require(build_attempt <= current_attempt, "Mobile build belongs to a future attempt")
    tag = f"mobile-build-{run_id}-{build_attempt}"

    manifest = read_json((SOURCE / "plugins/secure-messaging/manifest.json").read_bytes())
    manifest["version"] = version
    with zipfile.ZipFile(io.BytesIO(assets[PLUGIN_ZIP])) as archive:
        members = archive.infolist()
        require(len(members) == 3 and {entry.filename for entry in members}
                == {"manifest.json", "index.js", "plugin.jar"}, "Invalid Mobile plugin package")
        require(all(not entry.flag_bits & 1 and 0 < entry.file_size <= MAX_FILE_BYTES
                    for entry in members), "Invalid Mobile package member")
        require(archive.getinfo("manifest.json").file_size <= MAX_JSON_BYTES,
                "Packaged Mobile manifest exceeds its size limit")
        require(same_json(read_json(archive.read("manifest.json")), manifest),
                "Packaged Mobile manifest does not match the index and source")

    hashes = {name: hashlib.sha256(assets[name]).hexdigest() for name in CHECKSUM_FILES}
    checksums = {}
    checksum_text = assets["SHA256SUMS"].decode("ascii")
    require(checksum_text.endswith("\n"), "Mobile checksums must end with an LF newline")
    for line in checksum_text[:-1].split("\n"):
        digest, separator, name = line.partition("  ")
        require(separator and re.fullmatch(r"[a-f0-9]{64}", digest)
                and name in CHECKSUM_FILES and name not in checksums, "Invalid Mobile checksum entry")
        checksums[name] = digest
    require(checksums == hashes, "Mobile release checksums do not match the built files")

    config = read_json((SOURCE / "repo.config.json").read_bytes())
    expected = {
        "format": 1, "name": config["name"], "description": config["description"],
        "plugins": {PLUGIN: {
            **{key: manifest[key] for key in ("name", "description", "author", "icon")},
            "channels": {channel: version for channel in ("latest", "beta", "nightly")},
            "versions": {version: {
                "url": f"https://github.com/{repository}/releases/download/{tag}/{PLUGIN_ZIP}",
                "sha256": hashes[PLUGIN_ZIP], "size": len(assets[PLUGIN_ZIP]),
                "dependencies": manifest["dependencies"],
            }},
        }},
    }
    require(same_json(index, expected), "Mobile index does not match its immutable build identity")
    return tag


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 2, "Expected the Mobile release directory")
        print(validate_release(sys.argv[1], os.environ))
    except (ValueError, OSError, KeyError, TypeError, zipfile.BadZipFile) as error:
        print(f"Refusing Mobile publication: {error}", file=sys.stderr)
        sys.exit(1)
