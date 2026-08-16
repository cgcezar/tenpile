import { DurableObject } from 'cloudflare:workers';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const STALE_MS = 15 * 60 * 1000;

export const makeCode = () => {
  let s = '';
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
};

export class Matchmaker extends DurableObject {
  async open() {
    const list = (await this.ctx.storage.get('open')) ?? [];
    const now = Date.now();
    const fresh = list.filter((r) => now - r.at < STALE_MS);

    // Pull the oldest still-open room rather than asking every room whether it
    // has space. Rooms push their own closure, so no fan-out RPC here.
    if (fresh.length) {
      const pick = fresh[0];
      await this.ctx.storage.put('open', fresh);
      return { code: pick.code, created: false };
    }

    const code = makeCode();
    await this.ctx.storage.put('open', [{ code, at: now }]);
    return { code, created: true };
  }

  async register(code) {
    const list = (await this.ctx.storage.get('open')) ?? [];
    const now = Date.now();
    const next = list.filter((r) => now - r.at < STALE_MS && r.code !== code);
    next.push({ code, at: now });
    await this.ctx.storage.put('open', next.slice(-50));
    return true;
  }

  async close(code) {
    const list = (await this.ctx.storage.get('open')) ?? [];
    await this.ctx.storage.put('open', list.filter((r) => r.code !== code));
    return true;
  }
}
