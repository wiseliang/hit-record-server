# 下载与操作指南

页面地址：https://wiseliang.cloud/student-recorder/releases/

页面源码位于 `public/releases/`，界面图片位于 `public/releases/images/`。截图使用本地示例数据，不上传真实学生信息。保持图中的按钮名称与应用一致。

每次新版本完成 APK 构建与签名核验后，使用 APK 和对应校验 JSON 更新下载：

```bash
node scripts/publish-release.cjs /绝对路径/新版.apk /绝对路径/安装包校验.json
```

脚本核对文件 SHA-256、版本代码和包名，将安装包复制到 `.data/public-downloads/`，再原子更新页面的 `release.json`。安装包不进入 Git，发布描述和图文说明进入 Git。默认目录只公开专门的安装包文件，不公开其他 `.data` 内容。

更新说明或操作步骤：编辑 `index.html`，替换对应示例截图；`release.js` 会自动显示最新版本、大小、校验码和下载链接。页面支持手机布局、图片放大、常见问题折叠、键盘操作和复制校验码。

下载路径 `/downloads/student-recorder-v版本号.apk` 保持版本固定；`/downloads/latest.apk` 始终指向当前版本。应用 API 路径不变。
