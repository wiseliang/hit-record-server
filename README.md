# 学工录入服务端

Express + MySQL + Playwright 后端，对应 Android 仓库 `wiseliang/student-recorder` 和微信小程序仓库 `wiseliang/HIT-RECORDER`。

## 配置与启动

1. `npm ci`，`npx playwright install --with-deps chromium`。
2. 复制 `.env.example` 为 `.env` 并填写数据库、原有 `ENCRYPTION_KEY`、微信配置。**保留原加密密钥**，避免已有凭证无法解密。
3. 用 `openssl rand -hex 32` 生成独立、持久保存的 `AUTH_SECRET`；不可使用公开示例值。更换密钥会使旧会话失效。
4. `npm start`。通过固定 HTTPS 域名反向代理到服务端端口。
5. 将允许维护学期基准的已认证用户 ID 配置到 `ADMIN_OPENIDS`，逗号分隔。

## 会话与升级

- 客户端和服务端必须配套升级。受保护接口要求 `Authorization: Bearer <token>`；`x-openid` 或请求中的 openid 本身不再授予权限。
- Android 首次登录传 `{platform: "android"}`，获得随机安装身份及签名会话；之后携带原 token 登录以续期。token 有效期为 30 天，启动客户端时续期。超过有效期且未续期，需要新建安装身份并重新配置学工凭证。历史仍属于原身份。
- 旧 Android `local_` / `dev_` 身份不可仅凭 openid 迁移，首次升级需要重新配置学校凭证；不自动关联未验证身份的旧历史。
- 小程序必须配置真实 `WX_APPID` / `WX_APPSECRET`，通过学校账号之外的微信登录建立客户端身份。未配置时返回 503；移除了以任意 code 推导身份的开发后门。小程序的微信身份不变。
- 任务及成绩查询按经过验证的用户 ID 检查所属关系，跨用户访问返回 404。
- 学期配置保存在 `.data/semester.json`（可通过 `SEMESTER_CONFIG_PATH` 指定）。该目录需持久化、可写；首次安装默认第 1 周为 2026-08-31，部署时由管理员设置当前学期周一。无需修改源码或重启，服务端、任务引擎及新客户端使用相同配置。
- 新会话不加载旧共享 Cookie 文件；结束会话会销毁浏览器上下文。旧 `xuegong_cookies.json` 不再用于登录，应从部署备份中妥善清理。
- Chromium 使用标准多进程模式，移除导致后续独立上下文失效的 `--single-process`。小内存部署需监测 Chrome 内存。

## 验证

```sh
npm test
npm run check:syntax
npm run test:browser
```

回归测试使用模拟数据库，不写入学校数据。浏览器烟雾测试只创建隔离上下文及本地测试 Cookie，不访问学校系统。真实 MySQL 的安装、数据库表结构及生产部署需在目标环境验证。

默认秋季基准已按[威海校区官方开学通知](https://office.hitwh.edu.cn/2026/0624/c4081a215253/page.htm)设置为 2026-08-31；2026-11-10 对应 2026—2027 学年秋季第 11 周。已经存在的 semester.json 优先级更高，升级不会覆盖人工配置。录入场景按配置基准确定学期，不再用周数判断春秋。
