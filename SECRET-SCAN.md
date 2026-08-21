# Secret scan — export diligence

Before this source became public, the originating tree and its full private
history (420 commits, all branches) were scanned with `gitleaks`. The only
findings were a **fabricated JWT used as input to the redaction test**
(`tests/diagnostics.test.ts` — a token whose payload is just a handle and whose
signature is fake), allowlisted in `.gitleaks.toml`.

No real credential, key, or token exists in this repository. Public-by-design
values that are *not* secrets: the app bundle identifier, the Apple code-signing
identity/Team ID (embedded in every shipped signed binary), and the updater's
minisign **public** key in `src-tauri/tauri.conf.json`. Signing private keys and
release credentials live outside this repository and are never referenced by
its workflows.

Re-run any time:

```bash
gitleaks detect --source . --config .gitleaks.toml --redact
```
