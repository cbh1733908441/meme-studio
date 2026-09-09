export class Pool {
  constructor(limit = 3) {
    this.limit = limit;
    this.active = 0;
    this.waiting = [];
    this.peak = 0;
  }
  get stats() {
    return {
      limit: this.limit,
      active: this.active,
      queued: this.waiting.length,
    };
  }
  run(fn, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("已取消"));
      const job = { fn, signal, resolve, reject };
      job.abort = () => {
        const i = this.waiting.indexOf(job);
        if (i >= 0) {
          this.waiting.splice(i, 1);
          reject(new Error("已取消"));
        }
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      this.waiting.push(job);
      this.pump();
    });
  }
  pump() {
    while (this.active < this.limit && this.waiting.length) {
      const j = this.waiting.shift();
      j.signal?.removeEventListener("abort", j.abort);
      if (j.signal?.aborted) {
        j.reject(new Error("已取消"));
        continue;
      }
      this.active++;
      this.peak = Math.max(this.peak, this.active);
      Promise.resolve()
        .then(j.fn)
        .then(j.resolve, j.reject)
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }
}
