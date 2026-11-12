# 学工录入服务端

> 本开发分支为 v1.12.0：新增 `/api/recognition`、可信学校身份桥接和持久同步worker。配置及验收见 [接入文档](docs/识同事接入与同步_v1.12.md)。下文v1.11为原稳定版记录。


Express + MySQL + Playwright 后端，对应 Android 仓库 `wiseliang/student-recorder` 和微信小程序仓库 `wiseliang/HIT-RECORDER`。

当前稳定版 **v1.11.0**，与 Android v1.11.0 配套使用。

[下载与图文指南](https://wiseliang.cloud/student-recorder/releases/) · [发布说明](docs/RELEASE-v1.11.0.md)

成绩查询默认仅所带学生，支持明确切换全专业；提供挂科关注、补考巡考和按新版八列模板一键导出所带学生照片。照片与名册按账户保护，不进入公开下载目录，不提供人脸识别。

## 配置与启动

1. `npm ci`，`npx playwright install --with-deps chromium`。
2. 复制 `.env.example` 为 `.env` 并填写数据库、原有 `ENCRYPTION_KEY`、微信配置。**保留原加密密钥**，避免已有凭证无法解密。
3. 用 `openssl rand -hex 32` 生成独立、持久保存的 `AUTH_SECRET`；不可使用公开示例值。更换密钥会使旧会话失效。
4. `npm start`。通过固定 HTTPS 域名反向代理到服务端端口。
5. 将允许维护学期基准的已认证用户 ID 配置到 `ADMIN_OPENIDS`，逗号分隔。

## 会话与升级

- 客户端和服务端必须配套升级。受保护接口要求 `Authorization: Bearer <token>`；`x-openid` 或请求中的 openid 本身不再授予权限。
- Android 首次登录传 `{platform: "android"}`，获得随机安装身份及签名会话；之后携带原 token 登录以续期。token 有效期为 30 天，启动客户端时续期。会话失效时可通过学校账号验证找回已绑定原账户；恢复码为可选备用。无已验证的历史绑定时，必须明确选择新建账户，不会自动认领他人历史。
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


## 当前服务部署（v1.11.0）

服务入口：`https://wiseliang.cloud/student-recorder`。后端由独立 systemd 服务运行，监听 loopback 4560，经 Nginx HTTPS 路径代理；MySQL 使用独立数据库和专用账号，运行密钥存放在 Git 仓库之外。

登录学校后调用 `/api/auth/academic-calendar`，直接读取学校 `getNdXqZM` 和 `getndlist`，按北京时间推导该学期第 1 周周一。学校返回的学年、学期及当前周次是依据；管理员手填和初始默认日期不再是正常录入时的唯一来源。每次新登录需重新核验。

创建任务必须拥有核验过的学校会话。服务端将学期快照写入任务 options；任务在 AsyncLocalStorage 中使用自己的快照，后续同步新学期不会改变已创建任务的补录日期。周汇总唯一键含 semester_start_date。学生以学号匹配每周名单，名单排序改变不会换成其他学生；该周没有选定学生时停止该周的单周录入。

新部署先对独立空库应用 `scripts/schema.sql`。旧部署升级需先备份数据库，并给 weekly_summary 添加 semester_start_date、重建唯一键；不可直接沿用旧的仅按 openid/week/type 的汇总键。

Android v1.11.0 配套使用该入口；修改周次后重新加载名单，专业班级设置在首次进入学业模块时触发。发布 APK 沿用已有签名，不包含学校密码。APK 原生构建工作流见客户端 `.github/workflows/android-apk.yml`。


## 私有照片导出与升级

`PHOTO_EXPORT_ROOT` 指向仓库及公开静态目录之外的持久化文件夹；目录 700、文件 600，按教师、任务、版本隔离。导出复用缓存、补齐缺失照片，生成八列 XLSX、照片目录、校验清单、说明及 ZIP。缺照片学生不进入主名册，部分失败和等待学校认证分别显示，不作为全部完成。压缩包下载需同账户、同管理范围授权。

`RELEASE_DOWNLOAD_DIR` 存放公开 APK；`public/releases/release.json` 指定最新版本和 SHA-256。公开下载目录不得存放学生数据。升级前备份数据库和私有存储，保留加密密钥，确认无运行中的写入任务，健康检查失败时回滚；集成测试只使用独立测试库。
