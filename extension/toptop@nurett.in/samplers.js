import GLib from 'gi://GLib';

const decoder = new TextDecoder();

function readProc(path) {
    const [ok, bytes] = GLib.file_get_contents(path);
    if (!ok) return null;
    return decoder.decode(bytes);
}

export class CpuSampler {
    constructor() {
        this._prevTotal = 0;
        this._prevIdle = 0;
        this._initialised = false;
    }

    sample() {
        const text = readProc('/proc/stat');
        if (!text) return null;
        const line = text.split('\n', 1)[0];
        const parts = line.trim().split(/\s+/).slice(1).map(Number);
        if (parts.length < 4) return null;
        const idle = parts[3] + (parts[4] || 0);
        const total = parts.reduce((a, b) => a + b, 0);
        const dTotal = total - this._prevTotal;
        const dIdle = idle - this._prevIdle;
        this._prevTotal = total;
        this._prevIdle = idle;
        if (!this._initialised) {
            this._initialised = true;
            return null;
        }
        if (dTotal <= 0) return null;
        return Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
    }
}

export class MemorySampler {
    sample() {
        const text = readProc('/proc/meminfo');
        if (!text) return null;
        const m = {};
        for (const line of text.split('\n')) {
            const match = line.match(/^(\w+):\s+(\d+)/);
            if (match) m[match[1]] = parseInt(match[2], 10);
        }
        if (!m.MemTotal) return null;
        const avail = m.MemAvailable ?? (m.MemFree + (m.Buffers || 0) + (m.Cached || 0));
        return ((m.MemTotal - avail) / m.MemTotal) * 100;
    }
}

const SKIP_PREFIXES = ['lo', 'docker', 'br-', 'virbr', 'veth', 'tun', 'tap'];

export class NetworkSampler {
    constructor() {
        this._prevRx = 0;
        this._prevTx = 0;
        this._prevAt = 0;
    }

    sample() {
        const text = readProc('/proc/net/dev');
        if (!text) return null;
        let rx = 0, tx = 0;
        for (const line of text.split('\n')) {
            const idx = line.indexOf(':');
            if (idx < 0) continue;
            const name = line.slice(0, idx).trim();
            if (SKIP_PREFIXES.some(p => name === p || name.startsWith(p))) continue;
            const fields = line.slice(idx + 1).trim().split(/\s+/).map(Number);
            if (fields.length < 16) continue;
            rx += fields[0];
            tx += fields[8];
        }
        const now = GLib.get_monotonic_time();
        if (this._prevAt === 0) {
            this._prevRx = rx;
            this._prevTx = tx;
            this._prevAt = now;
            return null;
        }
        const dt = (now - this._prevAt) / 1_000_000;
        const result = {
            rxBps: Math.max(0, (rx - this._prevRx) / dt),
            txBps: Math.max(0, (tx - this._prevTx) / dt),
        };
        this._prevRx = rx;
        this._prevTx = tx;
        this._prevAt = now;
        return result;
    }
}
