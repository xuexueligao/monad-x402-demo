"""Package only reviewed application source; never include local credentials."""
from pathlib import Path
import hashlib
import json
import zipfile

project = Path(__file__).resolve().parents[1]
submission = project / ".local" / "submission"
submission.mkdir(parents=True, exist_ok=True)
files = [
    "README.md", "AGENTS.md", "package.json", "package-lock.json",
    "tsconfig.json", "next-env.d.ts", "next.config.ts", ".gitignore", ".env.example", "run.ps1",
    "src/lib/network.ts", "src/app/layout.tsx", "src/app/page.tsx", "src/app/globals.css",
    "src/app/api/config/route.ts", "src/app/api/premium/route.ts", "src/app/api/source/route.ts",
    "scripts/create-test-wallet.mjs", "scripts/smoke.mjs", "scripts/pay-testnet.mjs",
    "scripts/verify-browser.mjs", "scripts/package-submission-source.py",
]
archive = submission / "monad-x402-demo-source.zip"
for filename in files:
    source = (project / filename).resolve()
    if not source.is_relative_to(project) or not source.is_file():
        raise RuntimeError(f"Unexpected or missing source file: {filename}")
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as package:
    for filename in files:
        package.write(project / filename, f"monad-x402-demo/{filename}")
with zipfile.ZipFile(archive) as package:
    entries = package.namelist()
    assert len(entries) == len(files)
    assert not any("/.local/" in entry or entry.endswith("/.env.local") for entry in entries)
result = {
    "archive": str(archive), "files": len(files), "bytes": archive.stat().st_size,
    "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
    "privateRuntimeFilesIncluded": False,
}
(submission / "source-manifest.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(result, ensure_ascii=False))
