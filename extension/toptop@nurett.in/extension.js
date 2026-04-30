import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {CpuSampler, MemorySampler, SwapSampler, NetworkSampler} from './samplers.js';
import {Indicator} from './indicators.js';

function formatBytes(bps) {
    const units = ['B', 'K', 'M', 'G'];
    let v = bps, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    let s;
    if (v >= 100) s = v.toFixed(0);
    else if (v >= 10) s = v.toFixed(1);
    else s = v.toFixed(2);
    return `${s.padStart(4, ' ')}${units[i]}`;
}

const SPECS = [
    {
        kind: 'cpu',
        role: 'toptop-cpu',
        showKey: 'show-cpu',
        position: 0,
        sampler: () => new CpuSampler(),
        options: {
            fixedMax: 100,
            color: [0.40, 0.85, 1.00],
            initialLabel: '  --%',
            format: v => `${v == null ? ' --' : v.toFixed(0).padStart(3, ' ')}%`,
        },
    },
    {
        kind: 'memory',
        role: 'toptop-memory',
        showKey: 'show-memory',
        position: 1,
        sampler: () => new MemorySampler(),
        options: {
            fixedMax: 100,
            color: [0.60, 1.00, 0.60],
            initialLabel: '  --%',
            format: v => `${v == null ? ' --' : v.toFixed(0).padStart(3, ' ')}%`,
        },
    },
    {
        kind: 'swap',
        role: 'toptop-swap',
        showKey: 'show-swap',
        position: 2,
        sampler: () => new SwapSampler(),
        options: {
            fixedMax: 100,
            color: [1.00, 0.85, 0.40],
            initialLabel: '  --%',
            format: v => `${v == null ? ' --' : v.toFixed(0).padStart(3, ' ')}%`,
        },
    },
    {
        kind: 'network',
        role: 'toptop-network',
        showKey: 'show-network',
        position: 3,
        sampler: () => new NetworkSampler(),
        options: {
            color: [1.00, 0.70, 0.40],
            initialLabel: '   --↓    --↑',
            format: v => v == null
                ? '   --↓    --↑'
                : `${formatBytes(v.rxBps)}↓ ${formatBytes(v.txBps)}↑`,
        },
    },
];

export default class TopTopExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicators = {};
        this._samplers = Object.fromEntries(
            SPECS.map(s => [s.kind, s.sampler()])
        );

        this._buildIndicators();

        this._settingsHandlers = [
            this._settings.connect('changed::interval-ms', () => this._restartTimer()),
            this._settings.connect('changed::history-size', () => this._applyHistorySize()),
            this._settings.connect('changed::graph-width', () => this._applyGraphWidth()),
            this._settings.connect('changed::show-cpu', () => this._rebuildIndicators()),
            this._settings.connect('changed::show-memory', () => this._rebuildIndicators()),
            this._settings.connect('changed::show-swap', () => this._rebuildIndicators()),
            this._settings.connect('changed::show-network', () => this._rebuildIndicators()),
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
