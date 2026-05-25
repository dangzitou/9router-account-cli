# 9router 账号导入器

一个轻量、零依赖的 CLI，用来把账号 JSON 导入到 9router 的 SQLite 数据库里。

## 用法

```bash
cd /path/to/9router-account-importer
npm link
```

第一次只需要执行一次 `npm link`。之后直接用：

```bash
9r-account import
9r-account paste
9r-account detect
9r-account import ./account.json
9r-account list --provider codex
```

最常用的是 `9r-account import`：它会直接读取剪贴板里的账号 JSON，自动激活账号，并清理旧代理绑定。`9r-account paste` 是同一个导入动作的别名。

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
- 剪贴板导入默认等价于带上 `--activate --clear-proxy`。
- 如果不想自动激活账号，使用 `--keep-status`。
- 如果不想清理旧代理绑定，使用 `--keep-proxy`。
- 输入 `9r-account help` 可以查看用法。
