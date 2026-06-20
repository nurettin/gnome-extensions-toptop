import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}

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
    last() { return this._data[this._data.length - 1] ?? 0; }
    max() {
        let m = 0;
        for (const v of this._data) if (Number.isFinite(v) && v > m) m = v;
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
        this._minPeak = options.minPeak ?? 0;
        this._format = options.format;
        this._labelText = options.initialLabel ?? '-';
        this._labelFontSize = options.labelFontSize ?? 10;
        this._labelPosition = options.labelPosition ?? 'bottom-right';
        this._minGraphWidth = options.minGraphWidth ?? 0;
        this._scalar = options.scalar ?? (value => typeof value === 'number'
            ? value
            : value.rxBps + value.txBps);
        this._drawMode = options.drawMode ?? 'sparkline';
        this._history = new RingBuffer(options.historySize);
        this._color = options.color;
        this._title = options.title ?? '';
        this._peak = this._minPeak;
        this._holdLeft = 0;
        this._holdSamples = options.holdSamples ?? 3;
        this._decaySamples = options.decaySamples ?? 10;

        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box toptop-box',
        });

        this._area = new St.DrawingArea({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'toptop-graph',
        });
        this._setAreaWidth(options.graphWidth);
        this._area.set_height(20);
        this._area.connect('repaint', a => this._onRepaint(a));

        this._box.add_child(this._area);
        this.add_child(this._box);
    }

    setGraphWidth(w) {
        this._setAreaWidth(w);
    }

    _setAreaWidth(w) {
        this._area.set_width(Math.max(w, this._minGraphWidth));
    }

    setHistorySize(n) {
        this._history.resize(n);
    }

    push(value) {
        const scalar = this._scalar(value);
        if (!Number.isFinite(scalar)) return;
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
        this._peak = Math.max(this._peak, this._minPeak);

        this._labelText = this._format(value, this._peak);
        this._area.queue_repaint();
    }

    _onRepaint(area) {
        const [w, h] = area.get_surface_size();
        const cr = area.get_context();
        try {
            if (this._drawMode === 'speedometer')
                this._drawSpeedometer(cr, w, h);
            else
                this._drawSparkline(cr, w, h);
            this._drawTitle(cr);
            this._drawLabel(cr, w, h);
        } finally {
            cr.$dispose();
        }
    }

    _drawSparkline(cr, w, h) {
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
            const y = h - clamp01(values[i] / max) * h;
            cr.lineTo(x, y);
        }
        cr.lineTo((startIdx + values.length - 1) * stepX, h);
        cr.closePath();
        cr.fill();

        cr.setLineWidth(1.5);
        cr.setSourceRGBA(r, g, b, 0.95);
        for (let i = 0; i < values.length; i++) {
            const x = (startIdx + i) * stepX;
            const y = h - clamp01(values[i] / max) * h;
            if (i === 0) cr.moveTo(x, y);
            else cr.lineTo(x, y);
        }
        cr.stroke();
    }

    _drawSpeedometer(cr, w, h) {
        const value = this._history.last();
        const max = Math.max(this._peak, 1);
        const ratio = clamp01(value / max);
        const angleStart = Math.PI;
        const angleEnd = Math.PI * 2;
        const angle = angleStart + (angleEnd - angleStart) * ratio;
        const [r, g, b] = this._color;
        const cx = w / 2;
        const cy = h - 2;
        const radius = Math.max(1, Math.min(w / 2 - 3, h - 4));

        cr.setSourceRGBA(1, 1, 1, 0.06);
        cr.rectangle(0, 0, w, h);
        cr.fill();

        cr.setLineWidth(2);
        cr.setSourceRGBA(1, 1, 1, 0.18);
        cr.arc(cx, cy, radius, angleStart, angleEnd);
        cr.stroke();

        cr.setSourceRGBA(r, g, b, 0.95);
        cr.arc(cx, cy, radius, angleStart, angle);
        cr.stroke();

        cr.setLineWidth(1.4);
        cr.moveTo(cx, cy);
        cr.lineTo(cx + Math.cos(angle) * (radius - 2), cy + Math.sin(angle) * (radius - 2));
        cr.stroke();

        cr.arc(cx, cy, 1.7, 0, Math.PI * 2);
        cr.fill();
    }

    _drawTitle(cr) {
        if (!this._title) return;
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

    _drawLabel(cr, w, h) {
        if (!this._labelText) return;

        let fontSize = this._labelFontSize;
        cr.selectFontFace('monospace', 0, 1);
        cr.setFontSize(fontSize);
        let ext = cr.textExtents(this._labelText);
        while ((ext.width > w - 6 || ext.height > h - 4) && fontSize > 7) {
            fontSize -= 1;
            cr.setFontSize(fontSize);
            ext = cr.textExtents(this._labelText);
        }

        const x = Math.max(3, w - ext.width - 3);
        const baseline = this._labelPosition === 'top-right'
            ? 2 - ext.yBearing
            : h - 3;
        const boxX = Math.max(1, x + ext.xBearing - 2);
        const boxY = Math.max(1, baseline + ext.yBearing - 1);

        cr.setSourceRGBA(0, 0, 0, 0.55);
        cr.rectangle(boxX, boxY, Math.min(w - boxX - 1, ext.width + 4), Math.min(h - boxY - 1, ext.height + 3));
        cr.fill();
        cr.setSourceRGBA(1, 1, 1, 0.95);
        cr.moveTo(x, baseline);
        cr.showText(this._labelText);
    }
});
