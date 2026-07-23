/**
 * Reads exact byte counts off a socket as promises.
 *
 * The scrcpy video stream is a sequence of fixed-size headers followed by
 * variable-size payloads, which is painful to express with raw 'data' events
 * because TCP will happily hand you half a header. This buffers until each
 * requested length is satisfiable.
 */
export class StreamReader {
  constructor(socket) {
    this.socket = socket;
    this.chunks = [];
    this.buffered = 0;
    this.pending = null; // { need, resolve, reject }
    this.ended = false;
    this.error = null;

    socket.on('data', (chunk) => {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
      this.#settle();
      // Stop reading if the consumer has fallen a long way behind.
      if (this.buffered > 16 << 20) socket.pause();
    });

    socket.on('end', () => this.#fail(new Error('device closed the video stream')));
    socket.on('close', () => this.#fail(new Error('video socket closed')));
    socket.on('error', (err) => this.#fail(err));
  }

  #fail(err) {
    if (this.ended) return;
    this.ended = true;
    this.error = err;
    if (this.pending) {
      const { reject } = this.pending;
      this.pending = null;
      reject(err);
    }
  }

  #take(need) {
    const out = Buffer.allocUnsafe(need);
    let offset = 0;
    while (offset < need) {
      const chunk = this.chunks[0];
      const take = Math.min(chunk.length, need - offset);
      chunk.copy(out, offset, 0, take);
      offset += take;
      if (take === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(take);
    }
    this.buffered -= need;
    if (this.buffered < 4 << 20) this.socket.resume();
    return out;
  }

  #settle() {
    if (!this.pending || this.buffered < this.pending.need) return;
    const { need, resolve } = this.pending;
    this.pending = null;
    resolve(this.#take(need));
  }

  /** Resolves with exactly `need` bytes, or rejects if the stream ends first. */
  read(need) {
    if (this.error) return Promise.reject(this.error);
    if (this.buffered >= need) return Promise.resolve(this.#take(need));
    if (this.pending) return Promise.reject(new Error('StreamReader supports one outstanding read'));
    return new Promise((resolve, reject) => {
      this.pending = { need, resolve, reject };
    });
  }
}
