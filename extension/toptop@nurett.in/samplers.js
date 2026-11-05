import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

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
const PROCESS_SAMPLE_MIN_US = 750_000;
const LARGEST_FILES_SCAN_US = 10 * 60 * 1_000_000;
const TOP_ROWS = 3;
const PROC_PID_RE = /^\d+$/;
const VM_RSS_RE = /^VmRSS:\s+(\d+)\s+kB$/m;

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

function readCpuTimes() {
    const text = readProc('/proc/stat');
    if (!text) return null;
    const line = text.split('\n', 1)[0];
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    if (parts.length < 4) return null;
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    return {idle, total};
}

function parseProcessStat(pid, text) {
    const open = text.indexOf('(');
    const close = text.lastIndexOf(')');
    if (open < 0 || close <= open) return null;

    const fields = text.slice(close + 1).trim().split(/\s+/);
    if (fields.length < 20) return null;

    const utime = Number.parseInt(fields[11], 10);
    const stime = Number.parseInt(fields[12], 10);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;

    const name = text.slice(open + 1, close).trim() || String(pid);
    const startTime = fields[19];
    return {
        name,
        key: `${pid}\0${startTime}`,
        cpuTicks: utime + stime,
    };
}

function readProcessRssKb(pid) {
    const text = readProc(`/proc/${pid}/status`);
    if (!text) return 0;
    const match = text.match(VM_RSS_RE);
    if (match == null) return 0;
    const rssKb = Number.parseInt(match[1], 10);
    return Number.isFinite(rssKb) ? rssKb : 0;
}

function readProcesses() {
    const processes = [];
    for (const name of listDir('/proc')) {
        if (!PROC_PID_RE.test(name)) continue;

        const statText = readProc(`/proc/${name}/stat`);
        if (statText == null) continue;

        const process = parseProcessStat(name, statText);
        if (process == null) continue;

        process.rssKb = readProcessRssKb(name);
        processes.push(process);
    }
    return processes;
}

function topRows(rows, valueOf) {
    return rows
        .filter(row => valueOf(row) > 0)
        .sort((a, b) => valueOf(b) - valueOf(a))
        .slice(0, TOP_ROWS);
}

// Runs argv asynchronously at most once per intervalUs, never overlapping.
class PeriodicCommand {
    constructor(argv, intervalUs, onFinish) {
        this._argv = argv;
        this._intervalUs = intervalUs;
        this._onFinish = onFinish;
        this._lastStartAt = -Infinity;
        this._running = false;
    }

    poll() {
        const now = GLib.get_monotonic_time();
        if (this._running || now - this._lastStartAt < this._intervalUs) return;
        this._running = true;
        this._lastStartAt = now;

        let proc;
        try {
            proc = Gio.Subprocess.new(
                this._argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );
        } catch (e) {
            this._running = false;
            this._onFinish(null, `\`${this._argv[0]}\` unavailable`);
            return;
        }

        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                this._onFinish(stdout ?? '', null);
            } catch (e) {
                this._onFinish(null, `\`${this._argv[0]}\` failed`);
            } finally {
                this._running = false;
            }
        });
    }
}

export class ProcessSampler {
    constructor() {
        this._prevTotalTicks = null;
        this._prevTicksByProcess = new Map();
        this._lastSampleAt = 0;
        this._snapshot = {
            cpu: {rows: [], updatedAt: 0},
            memory: {rows: [], updatedAt: 0},
        };
    }

    sample(totalTicks) {
        const now = GLib.get_monotonic_time();
        if (now - this._lastSampleAt < PROCESS_SAMPLE_MIN_US)
            return this._snapshot;

        const processes = readProcesses();
        const snapshot = {
            cpu: {
                rows: this._cpuRows(processes, totalTicks),
                updatedAt: now,
            },
            memory: {
                rows: this._memoryRows(processes),
                updatedAt: now,
            },
        };

        this._prevTicksByProcess = new Map(
            processes.map(process => [process.key, process.cpuTicks])
        );
        if (totalTicks != null)
            this._prevTotalTicks = totalTicks;
        this._lastSampleAt = now;
        this._snapshot = snapshot;
        return snapshot;
    }

    _cpuRows(processes, totalTicks) {
        if (totalTicks == null || this._prevTotalTicks == null)
            return [];

        const totalDelta = totalTicks - this._prevTotalTicks;
        if (totalDelta <= 0) return [];

        const rowsByName = new Map();
        for (const process of processes) {
            const prevTicks = this._prevTicksByProcess.get(process.key);
            if (prevTicks == null) continue;

            const tickDelta = process.cpuTicks - prevTicks;
            if (tickDelta <= 0) continue;

            const row = rowsByName.get(process.name) ?? {
                name: process.name,
                percent: 0,
            };
            row.percent += (tickDelta / totalDelta) * 100;
            rowsByName.set(process.name, row);
        }

        return topRows([...rowsByName.values()], row => row.percent);
    }

    _memoryRows(processes) {
        const rowsByName = new Map();
        for (const process of processes) {
            if (process.rssKb <= 0) continue;

            const row = rowsByName.get(process.name) ?? {
                name: process.name,
                rssKb: 0,
            };
            row.rssKb += process.rssKb;
            rowsByName.set(process.name, row);
        }

        return topRows([...rowsByName.values()], row => row.rssKb);
    }
}

export class CpuSampler {
    constructor(processSampler) {
        this._processSampler = processSampler;
        this._prevTotal = 0;
        this._prevIdle = 0;
        this._initialised = false;
    }

    sample() {
        const times = readCpuTimes();
        if (times == null) return null;

        const {idle, total} = times;
        const processSnapshot = this._processSampler.sample(total);
        const dTotal = total - this._prevTotal;
        const dIdle = idle - this._prevIdle;
        this._prevTotal = total;
        this._prevIdle = idle;
        if (!this._initialised) {
            this._initialised = true;
            return null;
        }
        if (dTotal <= 0) return null;
        return {
            percent: Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100)),
            processes: processSnapshot.cpu,
        };
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
    constructor(processSampler) {
        this._processSampler = processSampler;
    }

    sample() {
        const m = parseMeminfo();
        if (!m || !m.MemTotal) return null;
        const avail = m.MemAvailable ?? (m.MemFree + (m.Buffers || 0) + (m.Cached || 0));
        return {
            percent: ((m.MemTotal - avail) / m.MemTotal) * 100,
            processes: this._processSampler.sample(null).memory,
        };
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
const SS_USER_RE = /users:\(\("([^"]+)",pid=(\d+),fd=\d+\)/;
const SS_BYTES_RE = /\bbytes_sent:(\d+).*?\bbytes_received:(\d+)/;

function parseTcpSockets(text) {
    const sockets = new Map();
    let socket = null;

    for (const line of text.split('\n')) {
        if (!line) continue;

        if (!line.startsWith(' ') && !line.startsWith('\t')) {
            const user = line.match(SS_USER_RE);
            const parts = line.trim().split(/\s+/);
            if (user == null || parts.length < 5) {
                socket = null;
                continue;
            }

            const name = user[1];
            const pid = parseInt(user[2], 10);
            if (!Number.isFinite(pid)) {
                socket = null;
                continue;
            }

            socket = {
                id: `${parts[3]}\0${parts[4]}\0${name}\0${pid}`,
                name,
                pid,
                txBytes: 0,
                rxBytes: 0,
            };
            continue;
        }

        if (socket == null) continue;

        const bytes = line.match(SS_BYTES_RE);
        if (bytes == null) {
            socket = null;
            continue;
        }

        socket.txBytes = Number.parseInt(bytes[1], 10);
        socket.rxBytes = Number.parseInt(bytes[2], 10);
        if (Number.isFinite(socket.txBytes) && Number.isFinite(socket.rxBytes))
            sockets.set(socket.id, socket);
        socket = null;
    }

    return sockets;
}

class NetworkProcessSampler {
    constructor() {
        this._prevAt = 0;
        this._prevSockets = new Map();
        this._rows = [];
        this._error = null;
        this._updatedAt = 0;
        this._command = new PeriodicCommand(
            ['ss', '-Htinp'],
            PROCESS_SAMPLE_MIN_US,
            (stdout, error) => this._finish(stdout, error)
        );
    }

    sample() {
        this._command.poll();
        return {
            rows: this._rows,
            error: this._error,
            updatedAt: this._updatedAt,
        };
    }

    _finish(text, error) {
        if (error != null) {
            this._error = error;
            this._rows = [];
            return;
        }

        const now = GLib.get_monotonic_time();
        const sockets = parseTcpSockets(text);
        const byProcess = new Map();

        if (this._prevAt > 0) {
            const dt = Math.max(0.001, (now - this._prevAt) / 1_000_000);

            for (const [id, socket] of sockets) {
                const prev = this._prevSockets.get(id);
                if (prev == null) continue;

                const rxBytes = socket.rxBytes - prev.rxBytes;
                const txBytes = socket.txBytes - prev.txBytes;
                if (rxBytes < 0 || txBytes < 0) continue;

                const key = socket.name;
                const row = byProcess.get(key) ?? {
                    name: socket.name,
                    rxBps: 0,
                    txBps: 0,
                };
                row.rxBps += rxBytes / dt;
                row.txBps += txBytes / dt;
                byProcess.set(key, row);
            }
        }

        this._prevAt = now;
        this._prevSockets = sockets;
        this._error = null;
        this._updatedAt = now;
        this._rows = [...byProcess.values()]
            .filter(row => row.rxBps > 0 || row.txBps > 0)
            .sort((a, b) => (b.rxBps + b.txBps) - (a.rxBps + a.txBps))
            .slice(0, TOP_ROWS);
    }
}

// Hidden files and folders (caches, app state) are pruned unvisited; files under 1M are skipped
// so sort sees thousands of lines, not millions.
const LARGEST_FILES_SCRIPT =
    'find "$1" -xdev -name \'.*\' -prune -o -type f -size +1M -printf \'%s\\t%p\\n\' 2>/dev/null | sort -nr | head -n "$2"';
const LARGEST_FILE_RE = /^(\d+)\t(.+)$/;

function parseLargestFiles(text) {
    return text.split('\n')
        .map(line => line.match(LARGEST_FILE_RE))
        .filter(match => match != null)
        .map(match => ({bytes: Number.parseInt(match[1], 10), path: match[2]}));
}

export class DiskSampler {
    constructor(path) {
        this._file = Gio.File.new_for_path(path);
        this._largestFiles = {rows: [], error: null, updatedAt: 0};
        this._command = new PeriodicCommand(
            ['nice', '-n', '19', 'sh', '-c', LARGEST_FILES_SCRIPT, 'sh', path, String(TOP_ROWS)],
            LARGEST_FILES_SCAN_US,
            (stdout, error) => {
                this._largestFiles = {
                    rows: error == null ? parseLargestFiles(stdout) : [],
                    error,
                    updatedAt: GLib.get_monotonic_time(),
                };
            }
        );
    }

    sample() {
        this._command.poll();
        const info = this._file.query_filesystem_info('filesystem::free,filesystem::used', null);
        const freeBytes = info.get_attribute_uint64('filesystem::free');
        const usedBytes = info.get_attribute_uint64('filesystem::used');
        return {
            percent: (usedBytes / (usedBytes + freeBytes)) * 100,
            freeBytes,
            files: this._largestFiles,
        };
    }
}

export class NetworkSampler {
    constructor() {
        this._prevRx = 0;
        this._prevTx = 0;
        this._prevAt = 0;
        this._processSampler = new NetworkProcessSampler();
    }

    sample() {
        const text = readProc('/proc/net/dev');
        if (!text) return null;
        const processes = this._processSampler.sample();
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
            processes,
        };
        this._prevRx = rx;
        this._prevTx = tx;
        this._prevAt = now;
        return result;
    }
}
