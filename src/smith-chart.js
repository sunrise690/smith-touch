const NS = 'http://www.w3.org/2000/svg';
const CENTER = 400;
const RADIUS = 326;
const MAX_PICK_RADIUS = 0.985;
let nextChartId = 1;

const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
}[character]));
const finiteGamma = (value) => value && Number.isFinite(value.re) && Number.isFinite(value.im);
const position = (gamma) => ({ x: CENTER + gamma.re * RADIUS, y: CENTER - gamma.im * RADIUS });
const fixed = (value) => Number(value.toFixed(3));
const pointString = (gamma) => {
  const point = position(gamma);
  return `${fixed(point.x)},${fixed(point.y)}`;
};

function impedanceGamma(resistance, reactance) {
  const denominator = (resistance + 1) ** 2 + reactance ** 2;
  return {
    re: (resistance ** 2 + reactance ** 2 - 1) / denominator,
    im: 2 * reactance / denominator,
  };
}

function reactanceArc(reactance, mirror = false) {
  const points = [];
  // Sampling in log space keeps both the rim and the rightmost convergence smooth.
  for (let index = 0; index <= 200; index += 1) {
    const resistance = index === 0 ? 0 : Math.expm1((index / 200) * Math.log(100001));
    const gamma = impedanceGamma(resistance, reactance);
    points.push(pointString(mirror ? { re: -gamma.re, im: -gamma.im } : gamma));
  }
  points.push(pointString(mirror ? { re: -1, im: 0 } : { re: 1, im: 0 }));
  return `M${points.join(' L')}`;
}

function gridMarkup(showAdmittance, clipId) {
  const resistances = [0.2, 0.5, 1, 2, 5];
  const reactances = [0.2, 0.5, 1, 2, 5];
  const grid = (mirror = false) => {
    const polarity = mirror ? -1 : 1;
    return resistances.map((resistance) => {
      const cx = CENTER + polarity * (resistance / (resistance + 1)) * RADIUS;
      return `<circle cx="${fixed(cx)}" cy="${CENTER}" r="${fixed(RADIUS / (resistance + 1))}" class="${resistance === 1 ? 'grid-grid grid-major' : 'grid-grid'}"/>`;
    }).join('') + reactances.flatMap((reactance) => [-reactance, reactance]).map((reactance) => (
      `<path d="${reactanceArc(reactance, mirror)}" class="${Math.abs(reactance) === 1 ? 'grid-grid grid-major' : 'grid-grid'}"/>`
    )).join('');
  };
  const resistanceLabels = [0, ...resistances].map((resistance) => {
    const point = position(impedanceGamma(resistance, 0));
    return `<text x="${fixed(point.x + (resistance === 0 ? 11 : 0))}" y="${CENTER + 22}" class="grid-label" text-anchor="middle">${resistance}</text>`;
  }).join('');
  const reactanceLabels = reactances.flatMap((reactance) => [-reactance, reactance]).map((reactance) => {
    const gamma = impedanceGamma(0, reactance);
    const x = CENTER + gamma.re * (RADIUS + 20);
    const y = CENTER - gamma.im * (RADIUS + 20);
    return `<text x="${fixed(x)}" y="${fixed(y + 5)}" class="rim-label" text-anchor="middle">${reactance > 0 ? '+' : '−'}j${Math.abs(reactance)}</text>`;
  }).join('');
  return `
    <g clip-path="url(#${clipId})">
      <g class="impedance-grid">${grid()}</g>
      ${showAdmittance ? `<g class="admittance-grid">${grid(true)}</g>` : ''}
      <path d="M${CENTER - RADIUS} ${CENTER} H${CENTER + RADIUS}" class="real-axis"/>
    </g>
    <circle cx="${CENTER}" cy="${CENTER}" r="${RADIUS}" class="outer-rim"/>
    ${resistanceLabels}${reactanceLabels}
    <path d="M${CENTER - 6} ${CENTER} H${CENTER + 6} M${CENTER} ${CENTER - 6} V${CENTER + 6}" class="center-cross"/>
  `;
}

const CHART_STYLE = `
  .smith-background { fill: #fff; }
  .grid-grid { fill: none; stroke: #d8dde8; stroke-width: 1.15; }
  .grid-major { stroke: #bcc6d8; stroke-width: 1.4; }
  .admittance-grid .grid-grid { stroke: #002fa7; opacity: .19; stroke-dasharray: 3 5; }
  .real-axis { stroke: #aab5c8; stroke-width: 1.2; }
  .outer-rim { fill: none; stroke: #7e8da8; stroke-width: 1.65; }
  .center-cross { stroke: #50617d; stroke-width: 1.4; }
  .grid-label, .rim-label, .chart-caption, .point-label, .selected-label {
    font-family: 'Helvetica Neue', Helvetica, Arial, 'Microsoft YaHei', sans-serif;
    font-variant-numeric: tabular-nums;
  }
  .grid-label, .rim-label { fill: #697791; font-size: var(--smith-label-size, 14px); paint-order: stroke; stroke: #fff; stroke-width: 5px; stroke-linejoin: round; }
  .chart-caption { fill: #697791; font-size: var(--smith-caption-size, 15px); }
  .chart-caption-strong { fill: #1b2a47; }
  .vswr-circle { fill: #002fa7; fill-opacity: .027; stroke: #002fa7; stroke-opacity: .32; stroke-width: 1.4; stroke-dasharray: 5 6; }
  .sweep-path { fill: none; stroke: #617294; stroke-width: 2.25; stroke-dasharray: 3 5; stroke-linecap: round; }
  .trace-path { fill: none; stroke: #002fa7; stroke-width: 3.5; stroke-linecap: round; stroke-linejoin: round; }
  .point-hit { fill: transparent; cursor: pointer; }
  .point-disc { fill: #fff; stroke: #002fa7; stroke-width: 2.5; }
  .point-selected { fill: #002fa7; stroke: #fff; stroke-width: 3; }
  .point-halo { fill: #002fa7; opacity: .09; }
  .point-label { fill: #002fa7; font-size: 13px; font-weight: 700; text-anchor: middle; dominant-baseline: central; pointer-events: none; }
  .point-label-selected { fill: #fff; }
  .load-disc { stroke-dasharray: none; }
  .selected-label { fill: #002fa7; font-size: 15px; font-weight: 600; paint-order: stroke; stroke: #fff; stroke-width: 6px; stroke-linejoin: round; pointer-events: none; }
  .point-group { cursor: pointer; }
  .point-group[data-point-index="0"] { cursor: grab; }
`;

/** A dependency-free SVG Smith chart. All public gamma values are dimensionless. */
export class SmithChart {
  constructor(container, { onPick, onSelect } = {}) {
    if (!(container instanceof Element)) throw new TypeError('SmithChart requires a DOM container');
    this.container = container;
    this.onPick = onPick;
    this.onSelect = onSelect;
    this.clipId = `smith-disk-${nextChartId++}`;
    this.svg = document.createElementNS(NS, 'svg');
    this.svg.setAttribute('xmlns', NS);
    this.svg.setAttribute('viewBox', '0 0 800 800');
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.svg.setAttribute('role', 'img');
    this.svg.setAttribute('aria-label', '交互式 Smith 圆图，拖动圆图设置负载，点击编号选择匹配步骤');
    this.svg.classList.add('smith-svg');
    this.svg.style.cssText = 'display:block;width:100%;height:auto;aspect-ratio:1;touch-action:none;user-select:none;-webkit-user-select:none;overflow:visible;';
    this.container.append(this.svg);
    this.activePointer = null;
    this.handlePointerDown = this.pointerDown.bind(this);
    this.handlePointerMove = this.pointerMove.bind(this);
    this.handlePointerUp = this.pointerUp.bind(this);
    this.svg.addEventListener('pointerdown', this.handlePointerDown);
    this.svg.addEventListener('pointermove', this.handlePointerMove);
    this.svg.addEventListener('pointerup', this.handlePointerUp);
    this.svg.addEventListener('pointercancel', this.handlePointerUp);
    this.update();
  }

  update({
    z0 = 50, trace = [], sweep = [], selectedIndex = 0,
    showAdmittance = false, showVswr = true, loadGamma, frequencyMHz,
  } = {}) {
    this.state = { z0, trace, sweep, selectedIndex, showAdmittance, showVswr, loadGamma, frequencyMHz };
    const selected = trace[selectedIndex] || trace.at(-1);
    const selectedGamma = selected?.gamma || loadGamma;
    const selectedMagnitude = finiteGamma(selectedGamma) ? Math.hypot(selectedGamma.re, selectedGamma.im) : 0;
    const vswr = showVswr && selectedMagnitude > 0.0005 && selectedMagnitude <= 1.001
      ? `<circle cx="${CENTER}" cy="${CENTER}" r="${fixed(Math.min(selectedMagnitude, 1) * RADIUS)}" class="vswr-circle"/>` : '';
    let sweepPath = '';
    const sweepPoints = sweep.filter((point) => finiteGamma(point.gamma));
    if (sweepPoints.length > 1) {
      sweepPath = `<path d="M${sweepPoints.map((point) => pointString(point.gamma)).join(' L')}" class="sweep-path"/>`;
    }
    const traceSegments = [];
    for (let index = 1; index < trace.length; index += 1) {
      if (!finiteGamma(trace[index - 1].gamma) || !finiteGamma(trace[index].gamma)) continue;
      const pathPoints = Array.isArray(trace[index].pathGamma)
        ? trace[index].pathGamma.filter(finiteGamma)
        : [trace[index - 1].gamma, trace[index].gamma];
      if (pathPoints.length > 1) {
        traceSegments.push(`<path d="M${pathPoints.map(pointString).join(' L')}" class="trace-path"/>`);
      }
    }
    const dots = trace.map((point, index) => {
      if (!finiteGamma(point.gamma)) return '';
      const p = position(point.gamma);
      const isSelected = index === selectedIndex;
      const className = isSelected ? 'point-disc point-selected' : 'point-disc';
      // Numbered steps are actual circuit positions, with zero denoting the load.
      const dotRadius = isSelected ? 12 : 10;
      return `<g class="point-group" data-point-index="${index}" transform="translate(${fixed(p.x)} ${fixed(p.y)})">
        <title>${escapeText(`${index === 0 ? '负载' : `步骤 ${index}`}：${point.label || ''}`)}</title>
        ${isSelected ? '<circle r="23" class="point-halo"/>' : ''}
        <circle r="${dotRadius}" class="${className}${index === 0 ? ' load-disc' : ''}"/>
        <text y=".5" class="point-label${isSelected ? ' point-label-selected' : ''}">${index}</text>
        <circle r="24" class="point-hit"/>
      </g>`;
    }).join('');
    let loneLoad = '';
    if (!trace.length && finiteGamma(loadGamma)) {
      const p = position(loadGamma);
      loneLoad = `<g class="point-group" data-point-index="0" transform="translate(${fixed(p.x)} ${fixed(p.y)})"><circle r="22" class="point-halo"/><circle r="11" class="point-disc point-selected"/><circle r="25" class="point-hit"/></g>`;
    }
    let selectedLabel = '';
    if (selected && finiteGamma(selectedGamma)) {
      const p = position(selectedGamma);
      const anchor = p.x > CENTER + 170 ? 'end' : 'start';
      const x = anchor === 'end' ? p.x - 18 : p.x + 18;
      const y = p.y < 125 ? p.y + 33 : p.y - 21;
      const label = String(selected.label || (selectedIndex === 0 ? '负载' : `步骤 ${selectedIndex}`));
      selectedLabel = `<text x="${fixed(x)}" y="${fixed(y)}" text-anchor="${anchor}" class="selected-label">${escapeText(label.slice(0, 22))}</text>`;
    }
    this.svg.innerHTML = `<title>Smith 圆图，参考阻抗 ${escapeText(z0)} 欧姆</title>
      <style>${CHART_STYLE}</style>
      <defs><clipPath id="${this.clipId}"><circle cx="${CENTER}" cy="${CENTER}" r="${RADIUS + 1}"/></clipPath></defs>
      <rect class="smith-background" width="800" height="800"/>
      <text x="33" y="32" class="chart-caption chart-caption-strong">Z₀ = ${escapeText(Number(z0).toLocaleString('zh-CN', { maximumFractionDigits: 3 }))} Ω</text>
      <text x="767" y="32" class="chart-caption" text-anchor="end">${frequencyMHz != null && Number.isFinite(frequencyMHz) ? `${escapeText(Number(frequencyMHz).toLocaleString('zh-CN', { maximumFractionDigits: 3 }))} MHz` : '归一化阻抗'}</text>
      <text x="400" y="47" class="chart-caption" text-anchor="middle">感性 · +jX</text>
      ${gridMarkup(showAdmittance, this.clipId)}
      <g clip-path="url(#${this.clipId})">${vswr}${sweepPath}${traceSegments.join('')}</g>
      ${dots}${loneLoad}${selectedLabel}
      <text x="400" y="766" class="chart-caption" text-anchor="middle">容性 · −jX</text>
      <text x="33" y="791" class="chart-caption">${showAdmittance ? '实线：阻抗网格　虚线：导纳网格' : '网格读数为归一化阻抗 Z / Z₀'}</text>
      <text x="767" y="791" class="chart-caption" text-anchor="end">拖动设置负载</text>`;
  }

  eventGamma(event) {
    const bounds = this.svg.getBoundingClientRect();
    const scale = Math.min(bounds.width / 800, bounds.height / 800);
    if (!scale) return null;
    const offsetX = (bounds.width - 800 * scale) / 2;
    const offsetY = (bounds.height - 800 * scale) / 2;
    const x = (event.clientX - bounds.left - offsetX) / scale;
    const y = (event.clientY - bounds.top - offsetY) / scale;
    return { re: (x - CENTER) / RADIUS, im: (CENTER - y) / RADIUS };
  }

  pick(event) {
    const gamma = this.eventGamma(event);
    if (!gamma) return;
    const magnitude = Math.hypot(gamma.re, gamma.im);
    if (magnitude > MAX_PICK_RADIUS) {
      gamma.re *= MAX_PICK_RADIUS / magnitude;
      gamma.im *= MAX_PICK_RADIUS / magnitude;
    }
    this.onPick?.(gamma);
  }

  pointerDown(event) {
    if (event.button !== 0 || this.activePointer) return;
    const pointGroup = event.target.closest?.('[data-point-index]');
    const index = pointGroup ? Number(pointGroup.dataset.pointIndex) : null;
    const gamma = this.eventGamma(event);
    if (!pointGroup && (!gamma || Math.hypot(gamma.re, gamma.im) > 1.04)) return;
    event.preventDefault();
    if (index != null) this.onSelect?.(index);
    if (index != null && index > 0) return;
    this.activePointer = { id: event.pointerId, x: event.clientX, y: event.clientY, picked: index == null };
    this.svg.setPointerCapture(event.pointerId);
    if (index == null) this.pick(event);
  }

  pointerMove(event) {
    const pointer = this.activePointer;
    if (!pointer || pointer.id !== event.pointerId) return;
    event.preventDefault();
    if (pointer.picked || Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 3) {
      pointer.picked = true;
      this.pick(event);
    }
  }

  pointerUp(event) {
    if (!this.activePointer || this.activePointer.id !== event.pointerId) return;
    event.preventDefault();
    if (this.activePointer.picked && event.type !== 'pointercancel') this.pick(event);
    if (this.svg.hasPointerCapture(event.pointerId)) this.svg.releasePointerCapture(event.pointerId);
    this.activePointer = null;
  }

  exportSvg() {
    const clone = this.svg.cloneNode(true);
    clone.setAttribute('width', '1200');
    clone.setAttribute('height', '1200');
    clone.removeAttribute('class');
    clone.removeAttribute('style');
    clone.querySelectorAll('.point-hit').forEach((element) => element.remove());
    return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
  }

  destroy() {
    this.svg.removeEventListener('pointerdown', this.handlePointerDown);
    this.svg.removeEventListener('pointermove', this.handlePointerMove);
    this.svg.removeEventListener('pointerup', this.handlePointerUp);
    this.svg.removeEventListener('pointercancel', this.handlePointerUp);
    this.svg.remove();
    this.activePointer = null;
  }
}
