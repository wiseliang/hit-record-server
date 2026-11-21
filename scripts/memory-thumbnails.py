"""Create bounded, orientation-correct portraits for the memory download."""
import base64
import binascii
import io
import json
import sys

from PIL import Image, ImageOps

MAX_BYTES = 12 * 1024
Image.MAX_IMAGE_PIXELS = 15_000_000


def thumbnail(encoded):
    raw = base64.b64decode(encoded, validate=True)
    with Image.open(io.BytesIO(raw), formats=('JPEG', 'PNG')) as source:
        source.draft('RGB', (320, 320))
        image = ImageOps.exif_transpose(source).convert('RGB')
    image.thumbnail((320, 320), Image.Resampling.LANCZOS)
    for limit in (320, 256, 192, 144, 96):
        image.thumbnail((limit, limit), Image.Resampling.LANCZOS)
        for quality in (76, 62):
            out = io.BytesIO()
            image.save(out, 'JPEG', quality=quality, optimize=True)
            if out.tell() <= MAX_BYTES:
                return base64.b64encode(out.getvalue()).decode('ascii')
    return None


for line in sys.stdin:
    images = json.loads(line)
    result = {}
    for fingerprint, encoded in images.items():
        try:
            result[fingerprint] = thumbnail(encoded)
        except (OSError, ValueError, SyntaxError, binascii.Error, Image.DecompressionBombError):
            result[fingerprint] = None
    print(json.dumps(result, separators=(',', ':')), flush=True)
