# 9router 账号导入器

一个轻量、零依赖的 CLI，用来把账号 JSON 导入到 9router 的 SQLite 数据库里。

## 用法

```bash
cd /path/to/9router-account-importer
npm link

9r-account detect
9r-account import ./account.json
9r-account import ./account.json --clear-proxy --activate
9r-account list --provider codex
```

它会按这个顺序自动寻找数据库：

1. `--db /path/to/data.sqlite`
2. `--data-dir /path/to/.9router`
3. `DATA_DIR`
4. macOS/Linux：`~/.9router/db/data.sqlite`
5. Windows：`%APPDATA%/9router/db/data.sqlite`

## 输入格式

单个账号：

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

数组：

```json
[
  { "provider": "codex", "authType": "oauth", "email": "a@example.com" },
  { "provider": "codex", "authType": "oauth", "email": "b@example.com" }
]
```

完整的 9router 导出：

```json
{
  "providerConnections": [
    { "provider": "codex", "authType": "oauth", "email": "a@example.com" }
  ]
}
```

## 说明

- 只写 `providerConnections` 表。
- 已有账号会按 `id` 更新；OAuth 账号再按 `provider + authType + email` 匹配；API Key 账号按 `provider + authType + name` 匹配。
- 写入前默认会生成 `.bak.<时间戳>` 备份，除非传 `--no-backup`。
- 不会在终端输出明文 token。
