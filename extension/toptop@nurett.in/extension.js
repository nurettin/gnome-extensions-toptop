import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    ProcessSampler,
    CpuSampler,
    CpuTemperatureSampler,
    MemorySampler,
    SwapSampler,
    NetworkSampler,
    FanSpeedSampler,
} from './samplers.js';
import {Indicator} from './indicators.js';

function formatBytes(bytes) {
    const units = ['B', 'K', 'M', 'G'];
    let v = bytes, i = 0;
    while (v >= 999.5 && i < units.length - 1) { v /= 1024; i++; }
    let s;
    if (i === 0) s = v.toFixed(0);
    else if (v >= 10) s = v.toFixed(0);
    else s = v.toFixed(1);
    return `${s}${units[i]}`;
}

function samplePercent(value) {
    return typeof value === 'number' ? value : value?.percent;
}

function formatProcessName(name, width) {
    const text = name || '?';
    return text.length > width ? `${text.slice(0, width - 1)}~` : text;
}

function formatProcessPercent(percent) {
    if (percent == null) return '--%';
    return `${percent < 10 ? percent.toFixed(1) : percent.toFixed(0)}%`;
}

function formatProcessRows(processes, emptyText, formatValue) {
    if (processes == null || processes.updatedAt === 0)
        return ['Waiting for process samples'];

    const rows = processes.rows ?? [];
    if (rows.length === 0) return [emptyText];

    return rows.map(row => {
        const name = formatProcessName(row.name, 18).padEnd(18);
        return `${name} ${formatValue(row)}`;
    });
}

function formatCpuDetails(v) {
    return formatProcessRows(
        v?.processes,
        'No CPU process activity',
        row => formatProcessPercent(row.percent)
    );
}

function formatMemoryDetails(v) {
    return formatProcessRows(
        v?.processes,
        'No memory process data',
        row => formatBytes(row.rssKb * 1024)
    );
}

function formatNetworkDetails(v) {
    const processes = v?.processes;
    if (processes == null || processes.updatedAt === 0)
        return ['Waiting for process samples'];
    if (processes.error != null)
        return [processes.error];

    const rows = processes.rows ?? [];
    if (rows.length === 0) return ['No process traffic'];

    return rows.map(row => formatProcessName(row.name, 24));
}

function formatPercent(value) {
    const percent = samplePercent(value);
    return `${percent == null ? '--' : percent.toFixed(0)}%`;
}

function formatTemperature(celsius) {
    return `${celsius == null ? '--' : celsius.toFixed(0)}C`;
}

function formatRpm(rpm) {
    if (rpm == null) return '--R';
    const rounded = Math.round(rpm);
    if (rounded >= 10000)
        return `${(rounded / 1000).toFixed(0)}kR`;
    return `${rounded}R`;
}

const SPECS = [
    {
        kind: 'cpu',
        role: 'toptop-cpu',
        showKey: 'show-cpu',
        position: 0,
        sampler: processSampler => new CpuSampler(processSampler),
        options: {
            fixedMax: 100,
            color: [0.40, 0.85, 1.00],
            title: 'CPU',
            initialLabel: '--%',
            scalar: samplePercent,
            format: formatPercent,
            detailsTitle: 'Top CPU processes',
            detailsFormat: formatCpuDetails,
        },
    },
    {
        kind: 'cpu-temperature',
        role: 'toptop-cpu-temperature',
        showKey: 'show-cpu-temperature',
        position: 1,
        sampler: () => new CpuTemperatureSampler(),
        options: {
            fixedMax: 100,
            color: [1.00, 0.45, 0.45],
            title: 'TMP',
            initialLabel: '--C',
            format: formatTemperature,
        },
    },
    {
        kind: 'memory',
        role: 'toptop-memory',
        showKey: 'show-memory',
        position: 2,
        sampler: processSampler => new MemorySampler(processSampler),
        options: {
            fixedMax: 100,
            color: [0.60, 1.00, 0.60],
            title: 'MEM',
            initialLabel: '--%',
            scalar: samplePercent,
            format: formatPercent,
            detailsTitle: 'Top memory processes',
            detailsFormat: formatMemoryDetails,
        },
    },
    {
        kind: 'swap',
        role: 'toptop-swap',
        showKey: 'show-swap',
        position: 3,
        sampler: () => new SwapSampler(),
        options: {
            fixedMax: 100,
            color: [1.00, 0.85, 0.40],
            title: 'SWP',
            initialLabel: '--%',
            format: formatPercent,
        },
    },
    {
        kind: 'network',
        role: 'toptop-network',
        showKey: 'show-network',
        position: 4,
        sampler: () => new NetworkSampler(),
        options: {
            color: [1.00, 0.70, 0.40],
            title: 'NET',
            minGraphWidth: 86,
            initialLabel: '--↓ --↑',
            format: v => v == null
                ? '--↓ --↑'
                : `${formatBytes(v.rxBps)}↓ ${formatBytes(v.txBps)}↑`,
            detailsTitle: 'Top network processes',
            detailsFormat: formatNetworkDetails,
        },
    },
    {
        kind: 'fan-speed',
        role: 'toptop-fan-speed',
        showKey: 'show-fan-speed',
        position: 5,
        sampler: () => new FanSpeedSampler(),
        options: {
            minPeak: 5000,
            minGraphWidth: 48,
            color: [0.75, 0.80, 1.00],
            title: 'FAN',
            initialLabel: '--R',
            drawMode: 'speedometer',
            labelPosition: 'top-right',
            format: formatRpm,
        },
    },
];

export default class TopTopExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicators = {};
        this._processSampler = new ProcessSampler();
        this._samplers = Object.fromEntries(
            SPECS.map(s => [s.kind, s.sampler(this._processSampler)])
        );

        this._buildIndicators();

        this._settingsHandlers = [
            this._settings.connect('changed::interval-ms', () => this._restartTimer()),
            this._settings.connect('changed::history-size', () => this._applyHistorySize()),
            this._settings.connect('changed::graph-width', () => this._applyGraphWidth()),
            ...SPECS.map(spec => this._settings.connect(`changed::${spec.showKey}`, () => this._rebuildIndicators())),
        ];

        this._startTimer();
    }

    disable() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        for (const id of this._settingsHandlers ?? []) this._settings.disconnect(id);
        this._settingsHandlers = null;
        this._destroyIndicators();
        this._samplers = null;
        this._processSampler = null;
        this._settings = null;
    }

    _buildIndicators() {
        const historySize = this._settings.get_int('history-size');
        const graphWidth = this._settings.get_int('graph-width');
        for (const spec of SPECS) {
            if (!this._settings.get_boolean(spec.showKey)) continue;
            const ind = new Indicator(spec.role, {
                ...spec.options,
                historySize,
                graphWidth,
            });
            Main.panel.addToStatusArea(spec.role, ind, spec.position, 'right');
            this._indicators[spec.kind] = ind;
        }
    }

    _destroyIndicators() {
        for (const ind of Object.values(this._indicators ?? {})) {
            ind.destroy();
        }
        this._indicators = {};
    }

    _rebuildIndicators() {
        this._destroyIndicators();
        this._buildIndicators();
    }

    _applyHistorySize() {
        const n = this._settings.get_int('history-size');
        for (const ind of Object.values(this._indicators)) ind.setHistorySize(n);
    }

    _applyGraphWidth() {
        const w = this._settings.get_int('graph-width');
        for (const ind of Object.values(this._indicators)) ind.setGraphWidth(w);
    }

    _startTimer() {
        const interval = this._settings.get_int('interval-ms');
        this._tick();
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _restartTimer() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        this._startTimer();
    }

    _tick() {
        for (const spec of SPECS) {
            const ind = this._indicators[spec.kind];
            if (!ind) continue;
            const v = this._samplers[spec.kind].sample();
            if (v != null) ind.push(v);
        }
    }
}
