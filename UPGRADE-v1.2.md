# v1.2 升级与运行

本版本将录入改为「学校身份核验 → 指定类型、人员、周次和实际时间 → 只读预览 → 幂等提交 → 逐条回查」。旧版直接录入接口返回 426，必须配套更新 App。

## 数据与身份

- 先备份数据库，再启动新版本；`scripts/migrate-v12.js` 仅新增表、字段和索引。
- 保留原 `AUTH_SECRET`、`ENCRYPTION_KEY` 和数据库，升级才可读取原凭证、迁移有效旧身份。
- 新身份 access token 有效 15 分钟，原生 SecureStore 保存 refresh token。更新时保留 60 秒响应丢失宽限窗口。
- 备份恢复码可换机恢复同一账户。恢复会撤销旧设备的 session，并阻止旧版无 sid token 再登录。恢复码重新生成后旧码失效。
- 已过期且没有恢复码的旧版匿名身份不能凭一个 openid 自动恢复，需核对原设备资料后由维护者处理，不能静默新建并丢弃历史。

## 安全提交

`POST /api/task/preview` 接受 `recordType`（talk/companion）、`mode`（record/missing）、`weeks`、`studentIds`、`schedule`、`content` 和 `calendarStartDate`。谈话需明确时长、方式、场景，陪伴需明确类型。一次最多 1500 个学生周次组合。

查询 `GET /api/task/plans/:id` 直到 ready，核对后使用 planId 和稳定的 requestId 提交 `POST /api/task/create`。重复请求返回同一任务，每个账户同时最多一个录入任务。预览不会按单双周或总欠缺次数推断记录类型。

保存后只有取得唯一匹配的学校记录才标记 succeeded。无法确认的保存标记 unconfirmed，只能先只读回查，不能自动重试。重试计划仅包含确定失败或未执行项。服务重启将活动任务收敛为 interrupted，并保留全部逐项回执。

暂停与取消在保存前的安全边界生效，UI 应展示 pause_requested/cancel_requested，而非提前宣告已暂停/已取消。系统会定时收敛没有执行器的陈旧任务。所有浏览器任务仅在短查询时使用数据库连接。

## 部署

- Node.js 22，MySQL 8，Playwright Chromium；安装依赖并执行 `npx playwright install --with-deps chromium`。
- 初次部署先导入 `scripts/schema.sql`；升级原库不要删除旧表。启动时自动迁移。
- `AUTH_SECRET`、`ENCRYPTION_KEY` 均需至少 32 字节；仅保存在权限 0600 的服务器环境文件。
- 服务监听 loopback，由 HTTPS 反代。Nginx 必须覆盖 `X-Forwarded-For` 为 `$remote_addr`，不要直接转发外部自报的 XFF；配套超时不少于 120 秒。
- `GET /api/health` 检查数据库与执行器状态；进程异常应由 systemd Restart=on-failure 自动重启。
- 使用 `BACKUP_DIR` 指向仓库外的私有目录。`node scripts/backup.js` 生成权限 0600 的逻辑备份，保留最近 14 份。备份目录不得放进公开下载目录。

## 验证

`npm test`：身份签名、校历、会话 TTL、QR/MFA 会话转移与学校私有接口认证判断。

`npm run test:integration`：须使用名称以 `_test` 或 `_stage` 结束的独立库；验证恢复撤销、refresh 宽限、数据库实际删除、8 次并发幂等、状态迁移、中断收据、分页和工作执行失败。禁止连接生产库运行。

`npm run test:browser`：真实 Chromium 上下文隔离，以及假学校表单中的小名单、同名学生按学号录入、保存回执、跳过重复、安全取消、无效选项和保存后结果不确定。

学校真实验证只能提交明确标记的测试记录；回查唯一记录 ID 后只清理这一条，不能按人员整批删除。
