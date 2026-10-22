"""Build a store ZIP from extension files only, without local credentials."""
from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parents[1]
extension = root / 'extension'
manifest = json.loads((extension / 'manifest.json').read_text())
output = root / 'dist' / f"proofclip-{manifest['version']}.zip"
output.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(extension.rglob('*')):
        if path.is_file() and not any(part.startswith('.') for part in path.relative_to(extension).parts):
            archive.write(path, path.relative_to(extension))
print(f'Created {output.relative_to(root)} ({output.stat().st_size:,} bytes)')
