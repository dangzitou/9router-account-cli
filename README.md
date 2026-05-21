# 9router Account Importer

Small zero-dependency CLI for importing account JSON into 9router's SQLite database.

## Usage

```bash
cd /path/to/9router-account-importer
npm link
```

After the one-time `npm link`, use:

```bash
9r-account detect
9r-account import ./account.json
9r-account import ./account.json --clear-proxy --activate
9r-account import --clipboard --activate --clear-proxy
9r-account list --provider codex
```

It auto-detects the database in this order:

1. `--db /path/to/data.sqlite`
2. `--data-dir /path/to/.9router`
3. `DATA_DIR`
4. macOS/Linux: `~/.9router/db/data.sqlite`
5. Windows: `%APPDATA%/9router/db/data.sqlite`

## Input Shapes

Single account:

```json
{
  "provider": "codex",
  "authType": "oauth",
  "email": "user@example.com",
  "accessToken": "...",
  "refreshToken": "...",
  "providerSpecificData": {
    "chatgptAccountId": "...",
    "chatgptPlanType": "plus"
  }
}
```

Array:

```json
[
  { "provider": "codex", "authType": "oauth", "email": "a@example.com" },
  { "provider": "codex", "authType": "oauth", "email": "b@example.com" }
]
```

Full 9router export:

```json
{
  "providerConnections": [
    { "provider": "codex", "authType": "oauth", "email": "a@example.com" }
  ]
}
```

## Notes

- Writes only the `providerConnections` table.
- Existing accounts are updated by `id`, then by `provider + authType + email` for OAuth, then by `provider + authType + name` for API key.
- A `.bak.<timestamp>` copy is created next to the database before write unless `--no-backup` is passed.
- Tokens are never printed.
- For long JSON, prefer `9r-account import --clipboard` instead of pasting directly into the terminal.
