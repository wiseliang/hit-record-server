class SessionStore extends Map {
  constructor({
    ttlMs,
    maxAgeMs = Infinity,
    onExpire,
    now = Date.now,
    intervalMs = 30000,
  } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.maxAgeMs = maxAgeMs;
    this.onExpire = onExpire;
    this.now = now;
    this.timer = setInterval(() => this.prune(), intervalMs);
    this.timer.unref();
  }
  set(key, value) {
    value._createdAt ??= this.now();
    value._lastUsed = this.now();
    return super.set(key, value);
  }
  get(key) {
    const value = super.get(key);
    if (value) value._lastUsed = this.now();
    return value;
  }
  peek(key) {
    return super.get(key);
  }
  async dispose(key) {
    const value = super.get(key);
    super.delete(key);
    if (value) await this.onExpire?.(value);
  }
  async prune() {
    for (const [key, value] of this)
      if (
        !value.busyPlan &&
        (this.now() - value._lastUsed > this.ttlMs ||
          this.now() - value._createdAt > this.maxAgeMs)
      )
        await this.dispose(key).catch(() => {});
  }
  close() {
    clearInterval(this.timer);
  }
}
module.exports = { SessionStore };
