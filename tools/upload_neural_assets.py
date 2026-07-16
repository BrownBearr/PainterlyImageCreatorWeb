"""Upload the neural-mode runtime assets to B2 (served via cdn.shivav.space).

Uploads, under the `painterly/` prefix of the daysofshiva-source bucket:
  - paint-transformer-v1.fp16.onnx        (from tools/convert_paint_transformer.py)
  - ort/<ver>/ort-wasm-simd-threaded{,.jsep}.{wasm,mjs}  (from the onnxruntime-web npm tarball)

Uses B2's native API directly — no CLI needed. Reads the application key from
the B2_KEY_ID / B2_APP_KEY environment variables.

Usage:
  python upload_neural_assets.py <model.onnx> <ort_dist_dir> [ort_version]
"""

import hashlib
import json
import os
import sys
import urllib.parse
import urllib.request

ORT_FILES = [
    "ort-wasm-simd-threaded.wasm",
    "ort-wasm-simd-threaded.mjs",
    "ort-wasm-simd-threaded.jsep.wasm",
    "ort-wasm-simd-threaded.jsep.mjs",
]

CONTENT_TYPES = {
    ".onnx": "application/octet-stream",
    ".wasm": "application/wasm",
    ".mjs": "text/javascript",
}


def api(url, token, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Authorization": token})
    return json.load(urllib.request.urlopen(req))


def upload(auth, name, path):
    up = api(auth["apiUrl"] + "/b2api/v2/b2_get_upload_url",
             auth["authorizationToken"], {"bucketId": auth["allowed"]["bucketId"]})
    data = open(path, "rb").read()
    ext = os.path.splitext(path)[1]
    req = urllib.request.Request(up["uploadUrl"], data=data, headers={
        "Authorization": up["authorizationToken"],
        "X-Bz-File-Name": urllib.parse.quote(name),
        "Content-Type": CONTENT_TYPES.get(ext, "application/octet-stream"),
        "X-Bz-Content-Sha1": hashlib.sha1(data).hexdigest(),
        # Versioned filenames never change content — cache hard everywhere.
        "X-Bz-Info-b2-cache-control": urllib.parse.quote("public, max-age=31536000, immutable"),
    })
    r = json.load(urllib.request.urlopen(req))
    print(f"uploaded {name}  ({len(data) / 1e6:.1f} MB)  id={r['fileId']}")


def main():
    model_path = sys.argv[1]
    ort_dir = sys.argv[2]
    ort_ver = sys.argv[3] if len(sys.argv) > 3 else "1.27.0"

    key_id = os.environ["B2_KEY_ID"]
    app_key = os.environ["B2_APP_KEY"]
    req = urllib.request.Request("https://api.backblazeb2.com/b2api/v2/b2_authorize_account")
    import base64
    req.add_header("Authorization", "Basic " + base64.b64encode(f"{key_id}:{app_key}".encode()).decode())
    auth = json.load(urllib.request.urlopen(req))

    upload(auth, "painterly/paint-transformer-v1.fp16.onnx", model_path)
    for f in ORT_FILES:
        upload(auth, f"painterly/ort/{ort_ver}/{f}", os.path.join(ort_dir, f))


if __name__ == "__main__":
    main()
