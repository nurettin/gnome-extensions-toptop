import GLib from 'gi://GLib';

const decoder = new TextDecoder();

function readProc(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok) return null;
        return decoder.decode(bytes);
    } catch (e) {
        return null;
    }
}

function readNumber(path) {
    const text = readProc(path);
    if (text == null) return null;
    const value = Number.parseFloat(text.trim());
    return Number.isFinite(value) ? value : null;
}

function readLabel(path, fallback) {
    const text = readProc(path);
    if (text == null) return fallback;
    const label = text.trim();
    return label.length > 0 ? label : fallback;
}

function listDir(path) {
    try {
        const dir = GLib.Dir.open(path, 0);
        const names = [];
        let name;
        while ((name = dir.read_name()) !== null) names.push(name);
        dir.close();
        return names;
    } catch (e) {
        return [];
    }
}

const HWMON_DIR = '/sys/class/hwmon';

function hwmonDirs() {
    return listDir(HWMON_DIR)
        .filter(name => name.startsWith('hwmon'))
        .map(name => `${HWMON_DIR}/${name}`);
}

function numberedInputs(dir, prefix) {
    const re = new RegExp(`^${prefix}(\\d+)_input$`);
    return listDir(dir)
        .map(name => name.match(re))
        .filter(match => match != null)
        .map(match => match[1]);
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

function parseMeminfo() {
    const text = readProc('/proc/meminfo');
    if (!text) return null;
    const m = {};
    for (const line of text.split('\n')) {
        const match = line.match(/^(\w+):\s+(\d+)/);
        if (match) m[match[1]] = parseInt(match[2], 10);
    }
    return m;
}

export class MemorySampler {
    sample() {
        const m = parseMeminfo();
        if (!m || !m.MemTotal) return null;
        const avail = m.MemAvailable ?? (m.MemFree + (m.Buffers || 0) + (m.Cached || 0));
        return ((m.MemTotal - avail) / m.MemTotal) * 100;
    }
}

export class SwapSampler {
    sample() {
        const m = parseMeminfo();
        if (!m || !m.SwapTotal) return null;
        return ((m.SwapTotal - (m.SwapFree ?? 0)) / m.SwapTotal) * 100;
    }
}

function cpuTemperatureTier(chipName, label) {
    const chip = chipName.toLowerCase();
    const normalizedLabel = label.toLowerCase();
    if (['k10temp', 'coretemp', 'zenpower'].includes(chip)) return 0;
    if (normalizedLabel === 'cpu' || normalizedLabel.startsWith('core '))
        return 1;
    if (normalizedLabel.startsWith('package id ') || normalizedLabel === 'tctl' || normalizedLabel === 'tdie')
        return 1;
    if (chip === 'thinkpad' && normalizedLabel === 'temp1')
        return 2;
    if (chip === 'acpitz')
        return 3;
    return -1;
}

export class CpuTemperatureSampler {
    sample() {
        const candidatesByTier = [[], [], [], []];
        for (const dir of hwmonDirs()) {
            const chipName = readLabel(`${dir}/name`, '');
            for (const index of numberedInputs(dir, 'temp')) {
                const input = `${dir}/temp${index}_input`;
                const label = readLabel(`${dir}/temp${index}_label`, `temp${index}`);
                const tier = cpuTemperatureTier(chipName, label);
                if (tier < 0) continue;

                const milliCelsius = readNumber(input);
                if (milliCelsius == null) continue;
                const celsius = milliCelsius / 1000;
                if (celsius <= 0 || celsius > 150) continue;
                candidatesByTier[tier].push(celsius);
            }
        }

        for (const candidates of candidatesByTier) {
            if (candidates.length > 0)
                return Math.max(...candidates);
        }
        return null;
    }
}

export class FanSpeedSampler {
    sample() {
        const speeds = [];
        for (const dir of hwmonDirs()) {
            for (const index of numberedInputs(dir, 'fan')) {
                const rpm = readNumber(`${dir}/fan${index}_input`);
                if (rpm == null || rpm < 0) continue;
                speeds.push(rpm);
            }
        }
        if (speeds.length === 0) return null;
        return Math.max(...speeds);
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
