import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

class RingBuffer {
    constructor(size) {
        this.size = size;
        this._data = [];
    }
    push(v) {
        this._data.push(v);
        while (this._data.length > this.size) this._data.shift();
    }
    values() { return this._data; }
    max() {
        let m = 0;
        for (const v of this._data) if (v > m) m = v;
        return m;
    }
    resize(n) {
        this.size = n;
        while (this._data.length > n) this._data.shift();
    }
}

export const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(role, options) {
        super._init(0.0, role, true);
        this._fixedMax = options.fixedMax ?? null;
        this._format = options.format;
        this._history = new RingBuffer(options.historySize);
        this._color = options.color;
        this._title = options.title ?? '';
        this._peak = 0;
        this._holdLeft = 0;
        this._holdSamples = options.holdSamples ?? 3;
        this._decaySamples = options.decaySamples ?? 10;

        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box toptop-box',
        });

        this._label = new St.Label({
            text: options.initialLabel ?? '—',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'toptop-label',
        });

        this._area = new St.DrawingArea({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'toptop-graph',
        });
        this._area.set_width(options.graphWidth);
        this._area.set_height(20);
        this._area.connect('repaint', a => this._onRepaint(a));

        this._box.add_child(this._label);
        this._box.add_child(this._area);
        this.add_child(this._box);
    }

    setGraphWidth(w) {
        this._area.set_width(w);
    }

    setHistorySize(n) {
        this._history.resize(n);
    }

    push(value) {
        const scalar = typeof value === 'number'
            ? value
            : (value.rxBps + value.txBps);
        this._history.push(scalar);

        const windowMax = this._history.max();
        if (this._fixedMax != null) {
            this._peak = this._fixedMax;
        } else if (windowMax >= this._peak) {
            this._peak = windowMax;
            this._holdLeft = this._holdSamples;
        } else if (this._holdLeft > 0) {
            this._holdLeft -= 1;
        } else {
            const step = (this._peak - windowMax) / this._decaySamples;
            this._peak = Math.max(windowMax, this._peak - step);
        }

        this._label.text = this._format(value, this._peak);
        this._area.queue_repaint();
    }

    _onRepaint(area) {
        const [w, h] = area.get_surface_size();
        const cr = area.get_context();
        try {
            const values = this._history.values();
            const max = Math.max(this._peak, 1);
            const [r, g, b] = this._color;

            cr.setSourceRGBA(1, 1, 1, 0.06);
            cr.rectangle(0, 0, w, h);
            cr.fill();

            if (values.length < 2) return;

            const stepX = w / (this._history.size - 1);
            const startIdx = this._history.size - values.length;

            cr.setSourceRGBA(r, g, b, 0.25);
            cr.moveTo(startIdx * stepX, h);
            for (let i = 0; i < values.length; i++) {
                const x = (startIdx + i) * stepX;
                const y = h - (values[i] / max) * h;
                cr.lineTo(x, y);
            }
            cr.lineTo((startIdx + values.length - 1) * stepX, h);
            cr.closePath();
            cr.fill();

            cr.setLineWidth(1.5);
            cr.setSourceRGBA(r, g, b, 0.95);
            for (let i = 0; i < values.length; i++) {
                const x = (startIdx + i) * stepX;
                const y = h - (values[i] / max) * h;
                if (i === 0) cr.moveTo(x, y);
                else cr.lineTo(x, y);
            }
            cr.stroke();

            if (this._title) {
                cr.selectFontFace('monospace', 0, 1);
                cr.setFontSize(8);
                const ext = cr.textExtents(this._title);
                cr.setSourceRGBA(0, 0, 0, 0.55);
                cr.rectangle(2, 1, ext.width + 4, ext.height + 3);
                cr.fill();
                cr.setSourceRGBA(1, 1, 1, 0.85);
                cr.moveTo(4, 1 + ext.height + 1);
                cr.showText(this._title);
            }
        } finally {
            cr.$dispose();
        }
    }
});
