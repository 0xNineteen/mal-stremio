class RateLimiter {
  constructor(minIntervalMs = 350) {
    this.minIntervalMs = minIntervalMs;
    this.lastRequestAt = 0;
    this.chain = Promise.resolve();
  }

  schedule(fn) {
    const run = this.chain.then(async () => {
      const now = Date.now();
      const wait = Math.max(0, this.minIntervalMs - (now - this.lastRequestAt));
      if (wait) await new Promise(r => setTimeout(r, wait));
      this.lastRequestAt = Date.now();
      return fn();
    });

    this.chain = run.catch(() => {});
    return run;
  }
}

module.exports = { RateLimiter };