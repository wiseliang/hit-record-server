# 1.6.0 maintenance and recovery

The Android client is version 1.6.0 / versionCode 10. The existing three-step writing flow and explicit confirmation remain.

Run `node scripts/check-version.cjs`, `npm test`, `npm run check:syntax`, isolated database integration and `npm run test:browser` before release. Integration requires a database ending in `_stage` or `_test`; never point it at production.

Schema migration is additive and chained from migrate-v12. It adds school account fingerprints, account-scoped school form options and per-week overview partitions. Legacy unbound previews must be regenerated, not replayed. Current authenticated connections can still be resumed. New previews bind to the connection; task recovery additionally checks a stable school-account fingerprint when available. QR flows that cannot establish a stable account ID conservatively use a connection-specific fingerprint.

Overview updates reuse verified non-current, non-dirty weeks for up to 6 hours. A full refresh bypasses reuse. Each week retains its verification time. Failed reads checkpoint only complete partitions. Never turn unread partitions into zero counts. Stored task receipts are not used to invent school completion counts. Partition deletion cascades only when the temporary snapshot is removed.

A paused executor releases after 5 minutes at a pre-save checkpoint. Already saved records stay; unsaved operations remain retryable through the existing fresh-preview flow. Uncertain saves remain held for read-only verification.

Backups write `.partial`, await both mysqldump and the output stream, then rename before rotating. Keep the latest backup of up to 14 distinct dates plus the latest 3 files. Daily backup service remains enabled. Private recovery config is saved under `BACKUP_CONFIG_DIR` or a sibling `restore-private` directory, mode 0600. It includes the encryption/authentication configuration and semester config, never the public download directory or Git. Off-server backup is not configured by this change.

Restore into a separate database, compare all table counts and confirm that an encrypted credential can be decrypted using the protected recovery key. Do not expose the decrypted value. Keep SQL and private recovery configuration accessible to authorized maintainers, and protect them independently of public artifacts. Do not rotate ENCRYPTION_KEY in place: existing ciphertext requires the original key. A future rotation needs key-version migration and a tested rollback; this release does not rotate keys.

Temporary cleanup runs on startup and every 6 hours, deletes only expired non-scanning unused previews/snapshots and old expired app sessions, and retains tasks and receipts. Use `node scripts/performance-report.cjs` to summarize the last 7 days of existing systemd timing logs. Runtime metrics also record Node memory before and after a read/task; use these with browser context counts when diagnosing memory.

Academic access is separate: `/api/academic-access` requires app authentication and exposes start/code/status/release only. It never loads the retired shared cookie file and never exposes the old grade data mutation/extraction routes. The advanced app entry verifies VPN/new academic login only. A new school MFA code may be required; do not claim success while waiting for it. Certificate tolerance applies only to this independent school-VPN browser context. School data writing remains in the existing, separately confirmed log flows.

Deploy only when no task or scan is active. Back up first and preserve the previous service and backup unit files. Switch both units to the new source directory, restart and check local/public database health. On a failed deployment restore the previous units. If rolling back after new overview scans, discard the temporary partitioned overview snapshots before running the old server; preserve tasks, receipts, credentials and the pre-release SQL backup.

Publish APK metadata only after version, signature, permissions, API origin and SHA-256 have been verified. Verify complete public download bytes before running `scripts/finalize-release.cjs --apply`. The old-APK cleanup policy remains latest-only as requested.
