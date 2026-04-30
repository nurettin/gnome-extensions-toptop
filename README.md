# toptop

CPU, memory, and network indicators with sparklines in the GNOME 50 top bar.

![screenshot placeholder](docs/screenshot.png)

## Disclaimer

**This is an AI-assisted personal project.** I vibed it into existence with an LLM. I could have written it manually, I chose not to. I am not an expert at parsing `/proc`, I am not a GNOME extension wizard. The code works for me; whether it works for you is your problem.

**This is not a community project.** I will not merge pull requests. I will not respond to issues. I know that is considered a dick move in the open-source community. Consider yourself warned.

If that is a problem for you, fork it.

## Why

`system-monitor-next` stopped working on GNOME 50 and the upstream review queue is slow. I wanted my graphs back, I do not want to wait. So I rewrote a minimal version from scratch in modern GJS.

## What it does

- Three panel indicators: CPU usage (%), memory usage (%), network throughput (rx + tx, sparkline of the sum)
- Sticky-peak-with-decay autoscaling on the network graph so spikes are visible without the baseline jittering
- Configurable sample interval, history length, graph width, per-indicator visibility

## Install

```bash
git clone https://github.com/nurettin/toptop.git
ln -s "$PWD/toptop/extension/toptop@nurett.in" \
      ~/.local/share/gnome-shell/extensions/toptop@nurett.in
glib-compile-schemas \
      ~/.local/share/gnome-shell/extensions/toptop@nurett.in/schemas/
# Log out and log back in (Wayland needs a fresh shell to see new extensions)
gnome-extensions enable toptop@nurett.in
```

## Configure

```bash
gsettings set in.nurett.toptop interval-ms 1000      # sample period (200..10000)
gsettings set in.nurett.toptop history-size 60       # samples retained (10..600)
gsettings set in.nurett.toptop graph-width 60        # sparkline width in px (20..240)
gsettings set in.nurett.toptop show-cpu true
gsettings set in.nurett.toptop show-memory true
gsettings set in.nurett.toptop show-network true
```

## Requirements

- GNOME Shell 50

## License

GPL-2.0-or-later. See `LICENSE`.
