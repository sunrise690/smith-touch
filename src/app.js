import { complex, mag, phase, impedanceToGamma, gammaToImpedance, metrics, applyElement, networkTrace, sweepNetwork, parseTouchstone, interpolateTouchstone } from './rf.js';
import { SmithChart } from './smith-chart.js';
import { parseSMC } from './smc.js';
import { suggestMatch } from './match.js';
import { DEFAULT_PROJECT, validateProject, encodeProject, decodeProject, serializeProject } from './project.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const clone = (value) => structuredClone(value);
const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STORAGE_KEY = 'smith-touch.project.v1';
const NAMES = { seriesR: '串联电阻', seriesL: '串联电感', seriesC: '串联电容', shuntR: '并联电阻', shuntL: '并联电感', shuntC: '并联电容', line: '传输线', openStub: '开路并联支节', shortStub: '短路并联支节' };
const UNITS = { seriesR: 'Ω', shuntR: 'Ω', seriesL: 'nH', shuntL: 'nH', seriesC: 'pF', shuntC: 'pF', line: '°', openStub: '°', shortStub: '°' };
const SYMBOLS = {
  load: '<path d="M8 13h18m0-7h18v14H26V6m18 7h18"/>',
  R: '<path d="M3 13h17l4-7 6 14 6-14 6 14 4-7h21"/>',
  L: '<path d="M3 16h15c0-15 9-15 9 0 0-15 9-15 9 0 0-15 9-15 9 0 0-15 9-15 9 0h13"/>',
  C: '<path d="M3 13h27m0-9v18m10-18v18m0-9h27"/>',
  shuntR: '<path d="M3 4h64M35 4v5m-4 0h8v10h-8V9m4 10v5m-7 0h14"/>',
  shuntL: '<path d="M3 3h64M35 3v4c-10 0-10 5 0 5-10 0-10 5 0 5-10 0-10 5 0 5v3m-7 0h14"/>',
  shuntC: '<path d="M3 4h64M35 4v7m-10 0h20m-20 6h20m-10 0v7m-7 0h14"/>',
  line: '<path d="M3 8h16v-4h32v4h16M3 20h16v3h32v-3h16M19 8v12M51 8v12"/>',
  openStub: '<path d="M3 5h64M35 5v5m-6 0h12v12H29V10"/>',
  shortStub: '<path d="M3 5h64M35 5v5m-6 0h12v12H29V10m-4 14h20"/>',
};
let state = clone(DEFAULT_PROJECT);
let selectedId = null;
let trace = [];
let sweep = [];
let undo = [];
let redo = [];
let lastEdit = { key: '', time: 0 };
let inspectorSignature = '';
let steps = {};
let frame = null;
let saveTimer = null;
let toastTimer = null;
let keypad = null;

function number(value, digits = 2) {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? '—' : '∞';
  if (Math.abs(value) < 1e-10) return '0';
  if (Math.abs(value) >= 1e6 || Math.abs(value) < 0.001) return value.toExponential(2);
  return Number(value.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits, useGrouping: false });
}
function impedance(z, digits = 2) {
  if (!Number.isFinite(z.re) || !Number.isFinite(z.im)) return '∞';
  return `${number(z.re, digits)} ${z.im < -1e-10 ? '−' : '+'} j${number(Math.abs(z.im), digits)}`;
}
function frequency(value) { return value >= 1000 ? `${number(value / 1000, 4)} GHz` : `${number(value, 4)} MHz`; }
function currentElement() { return state.elements.find((element) => element.id === selectedId); }
function loadAt(fMHz = state.frequencyMHz) { return state.loadData ? gammaToImpedance(interpolateTouchstone(state.loadData, fMHz), state.loadData.z0) : clone(state.load); }
function toast(message, duration = 3600) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').classList.add('visible'); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), duration); }
function remember(key = '') {
  const now = performance.now();
  if (!key || lastEdit.key !== key || now - lastEdit.time > 650) { undo.push(clone(state)); if (undo.length > 80) undo.shift(); }
  lastEdit = { key, time: now }; redo = [];
}
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(STORAGE_KEY, serializeProject(state)); $('#local-status').textContent = '已自动保存到此设备'; } catch { $('#local-status').textContent = '本机存储不可用，请下载工程保存'; } }, 240);
}
function scheduleRender() { if (frame === null) frame = requestAnimationFrame(() => { frame = null; render(); }); }

function sampledTrace() {
  const result = networkTrace(loadAt(), state.elements, state.frequencyMHz, state.z0);
  let previous = result[0];
  for (let i = 1; i < result.length; i++) {
    const e = state.elements.find((item) => item.id === result[i].elementId);
    const path = [previous.gamma];
    for (let j = 1; j <= 36; j++) {
      const t = j / 36;
      let value;
      if (['seriesC', 'shuntL', 'shuntR'].includes(e.type)) {
        if (e.value !== 0 || t === 1) value = e.value / t;
        else {
          const amount = t / (1 - t);
          const omega = 2 * Math.PI * state.frequencyMHz * 1e6;
          if (e.type === 'seriesC') value = 1e12 / (omega * state.z0 * amount);
          else if (e.type === 'shuntL') value = 1e9 * state.z0 / (omega * amount);
          else value = state.z0 / amount;
        }
      }
      else if (e.type === 'shortStub') {
        const ratio = state.frequencyMHz / (e.refMHz ?? state.frequencyMHz);
        const target = e.value * ratio;
        const start = 90 + 180 * Math.round((target - 90) / 180);
        value = (start + (target - start) * t) / ratio;
        if (value < 0) value = e.value;
      } else value = e.value * t;
      path.push(impedanceToGamma(applyElement(previous.z, { ...e, value }, state.frequencyMHz, state.z0), state.z0));
    }
    result[i].pathGamma = path;
    previous = result[i];
  }
  return result;
}

const chart = new SmithChart($('#smith-chart'), {
  onPick(gamma) {
    remember('chart-drag');
    if (state.loadData) { state.loadData = null; inspectorSignature = ''; toast('已切换为手动负载；可撤销恢复导入数据'); }
    const picked = gammaToImpedance(gamma, state.z0);
    state.load = { re: Math.max(0, Number(picked.re.toPrecision(7))), im: Number(picked.im.toPrecision(7)) };
    selectedId = null;
    scheduleRender();
  },
  onSelect(index) { selectedId = trace[index]?.elementId ?? null; render(); },
});

function selectedTraceIndex() {
  if (!selectedId) return 0;
  const exact = trace.findIndex((point) => point.elementId === selectedId);
  if (exact >= 0) return exact;
  const index = state.elements.findIndex((e) => e.id === selectedId);
  const previousIds = state.elements.slice(0, index).filter((e) => e.enabled !== false).map((e) => e.id);
  return Math.max(0, trace.findIndex((point) => point.elementId === previousIds.at(-1)));
}

function render() {
  try {
    trace = sampledTrace();
    sweep = state.sweep.enabled ? sweepNetwork(loadAt(), state.elements, { ...state.sweep, points: 161, z0: state.z0, loadAt }) : [];
    const selectedIndex = selectedTraceIndex();
    chart.update({ z0: state.z0, trace, sweep, selectedIndex, showAdmittance: state.showAdmittance, showVswr: state.showVswr, loadGamma: trace[0].gamma, frequencyMHz: state.frequencyMHz });
    const point = trace[selectedIndex];
    const m = metrics(point.z, state.z0);
    $('#project-title').textContent = state.name;
    $('#frequency-value').textContent = frequency(state.frequencyMHz);
    $('#z0-value').textContent = `${number(state.z0, 3)} Ω`;
    $('#metric-z').innerHTML = `${impedance(point.z)} <small>Ω</small>`;
    $('#metric-vswr').innerHTML = mag(m.gamma) > 1 + 1e-10 ? '—' : `${number(m.vswr, 3)}<small> : 1</small>`;
    $('#metric-rl').innerHTML = `${mag(m.gamma) < 1e-12 ? '∞' : number(m.returnLoss, 2)}<small> dB</small>`;
    $('#metric-gamma').textContent = number(mag(m.gamma), 4);
    $('#impedance-label').textContent = selectedIndex === 0 ? '负载阻抗 ZL' : selectedIndex === trace.length - 1 ? '输入阻抗 Zin' : `节点 ${selectedIndex} 阻抗`;
    $('#point-label').textContent = selectedIndex === 0 ? '负载节点' : `节点 ${selectedIndex} · ${point.label}`;
    $('#admittance-toggle').classList.toggle('active', state.showAdmittance);
    $('#admittance-toggle').setAttribute('aria-pressed', state.showAdmittance);
    $('#vswr-toggle').classList.toggle('active', state.showVswr);
    $('#vswr-toggle').setAttribute('aria-pressed', state.showVswr);
    $('#sweep-toggle').classList.toggle('active', state.sweep.enabled);
    $('#sweep-toggle').setAttribute('aria-pressed', state.sweep.enabled);
    $('#sweep-toggle').textContent = state.sweep.enabled ? '关闭扫描' : '开启扫描';
    $('#sweep-content').hidden = !state.sweep.enabled;
    $('#sweep-start-value').textContent = frequency(state.sweep.startMHz);
    $('#sweep-stop-value').textContent = frequency(state.sweep.stopMHz);
    $('#sweep-subtitle').textContent = state.loadData ? `${state.loadData.name} · ${state.loadData.points.length} 个负载频点` : '固定负载 · 理想无损元件';
    const activeData = mag(trace[0].gamma) > 1 + 1e-10 || sweep.some((p) => mag(p.gamma) > 1 + 1e-10);
    $('#chart-data-warning').hidden = !activeData;
    $('#chart-data-warning').textContent = activeData ? '有源数据：|Γ| > 1 的点位于圆外；VSWR 不适用，回波损耗可为负值。' : '';
    $('#undo-button').disabled = !undo.length;
    $('#redo-button').disabled = !redo.length;
    renderInspector();
    renderNetwork();
    if (state.sweep.enabled) renderSweep();
    persist();
  } catch (error) { toast(`计算未完成：${error.message}`, 6000); console.error(error); }
}

function parameters() {
  const element = currentElement();
  if (!element) {
    const z = loadAt();
    return [
      { key: 'loadR', label: '电阻 R', unit: 'Ω', value: z.re, min: 0, max: Math.max(200, Math.ceil(z.re / 50) * 100), limit: 1e9, step: steps.loadR ?? 1 },
      { key: 'loadX', label: '电抗 X', unit: 'Ω', value: z.im, min: -Math.max(200, Math.ceil(Math.abs(z.im) / 50) * 100), max: Math.max(200, Math.ceil(Math.abs(z.im) / 50) * 100), limit: 1e9, step: steps.loadX ?? 1 },
    ];
  }
  const type = element.type;
  const degree = ['line', 'openStub', 'shortStub'].includes(type);
  const max = degree ? Math.max(180, element.value * 1.5) : Math.max(type.endsWith('R') ? 500 : 200, element.value * 2);
  const result = [{ key: 'elementValue', label: degree ? '电长度 θ' : type.endsWith('R') ? '电阻 R' : type.endsWith('L') ? '电感 L' : '电容 C', unit: UNITS[type], value: element.value, min: 0, max, limit: 1e9, step: steps[type] ?? (degree ? 1 : type.endsWith('R') ? 1 : 0.1) }];
  if (degree) {
    result.push({ key: 'elementZ0', label: '特性阻抗 Zc', unit: 'Ω', value: element.z0 ?? state.z0, min: 1, max: Math.max(200, element.z0 * 2 || 200), limit: 1e6, step: steps.elementZ0 ?? 1 });
    result.push({ key: 'elementRef', label: '电长度参考频率', unit: 'MHz', value: element.refMHz ?? state.frequencyMHz, min: 0.001, max: Math.max(1000, element.refMHz * 2 || 1000), limit: 1e6, step: steps.elementRef ?? 1 });
  }
  return result;
}

function renderInspector() {
  const element = currentElement();
  const signature = `${selectedId || 'load'}:${element?.type || ''}:${!!state.loadData}`;
  const params = parameters();
  $('#parameter-controls').classList.toggle('single-parameter', params.length === 1);
  $('#selection-kicker').textContent = element ? `节点 ${state.elements.indexOf(element) + 1} / NETWORK` : '起点 / LOAD';
  $('#selection-title').textContent = element ? NAMES[element.type] : '负载阻抗';
  $('#selection-hint').textContent = element ? (['line', 'openStub', 'shortStub'].includes(element.type) ? `电长度以 ${frequency(element.refMHz ?? state.frequencyMHz)} 为参考；扫频时自动缩放。` : '点按数值使用数字盘，或拖动滑条连续调整。') : (state.loadData ? `数据负载：${state.loadData.name}。手动修改会转为固定负载，可撤销恢复。` : '拖动蓝色负载点，或点按数值精确设置。');
  $('#element-actions').hidden = !element;
  if (element) { $('#move-left').disabled = state.elements.indexOf(element) === 0; $('#move-right').disabled = state.elements.indexOf(element) === state.elements.length - 1; }
  if (signature !== inspectorSignature) {
    inspectorSignature = signature;
    $('#parameter-controls').innerHTML = params.map((p) => `<div class="parameter-control" data-param="${p.key}"><div class="parameter-label"><label for="range-${p.key}">${p.label}</label><span class="range-value">滑动调整</span></div><div class="stepper"><button class="step-button" data-step="${p.key}" data-direction="-1" aria-label="减小${p.label}">−</button><button class="value-button" data-edit="${p.key}" aria-label="精确设置${p.label}"><span></span><small>${p.unit}</small></button><button class="step-button" data-step="${p.key}" data-direction="1" aria-label="增大${p.label}">+</button></div><input class="range-input parameter-slider" id="range-${p.key}" data-range="${p.key}" type="range" aria-label="滑动调整${p.label}"><div class="step-settings"><span>步长</span>${[0.1, 1, 10].map((step) => `<button class="step-chip" data-step-size="${step}" data-for="${p.key}">${step}</button>`).join('')}</div></div>`).join('') + (element ? '<div class="bypass-control"><span>此元件参与计算</span><button id="bypass-button" class="toggle"></button></div>' : '');
  }
  for (const p of params) {
    const node = $(`[data-param="${p.key}"]`);
    node.querySelector('.value-button span').textContent = number(Number(p.value.toPrecision(5)), 5);
    const range = node.querySelector('input');
    if (document.activeElement !== range) { range.min = p.min; range.max = p.max; range.value = p.value; }
    range.step = p.step <= 0.1 ? 0.01 : p.step / 10;
    range.setAttribute('aria-valuetext', `${number(p.value, 5)} ${p.unit}`);
    node.querySelectorAll('[data-step-size]').forEach((button) => { const active = +button.dataset.stepSize === p.step; button.classList.toggle('active', active); button.setAttribute('aria-pressed', active); });
  }
  const bypass = $('#bypass-button');
  if (bypass) { bypass.textContent = element.enabled === false ? '已旁路' : '已启用'; bypass.classList.toggle('on', element.enabled !== false); bypass.setAttribute('aria-pressed', element.enabled !== false); }
}

function renderNetwork() {
  $('#network-count').textContent = `${state.elements.length} 个元件`;
  const icon = (type) => `<svg viewBox="0 0 70 28" aria-hidden="true">${SYMBOLS[type] || SYMBOLS[type.slice(-1)]}</svg>`;
  let html = `<button class="network-node${selectedId === null ? ' active' : ''}" data-select="load" aria-label="选择负载">${icon('load')}<strong>负载 ZL</strong><span>${impedance(loadAt())} Ω</span></button>`;
  html += state.elements.map((e, index) => `<div class="network-wire" aria-hidden="true"></div><button class="network-node${selectedId === e.id ? ' active' : ''}${e.enabled === false ? ' bypassed' : ''}" data-select="node:${escape(e.id)}" aria-label="选择${NAMES[e.type]}，${number(e.value, 5)}${UNITS[e.type]}">${icon(e.type)}<strong>${index + 1}. ${NAMES[e.type]}</strong><span>${number(e.value, 5)} ${UNITS[e.type]}${e.enabled === false ? ' · 旁路' : ''}</span></button>`).join('');
  const final = trace.at(-1);
  const m = metrics(final.z, state.z0);
  html += `<div class="network-wire" aria-hidden="true"></div><div class="network-result"><span>输入端 Zin</span><strong>${impedance(final.z)} Ω</strong><small>${mag(m.gamma) > 1 + 1e-10 ? '有源输入 · VSWR 不适用' : `VSWR ${number(m.vswr, 3)} : 1`}</small></div>`;
  $('#network-chain').innerHTML = html;
}

function renderSweep() {
  const slider = $('#frequency-slider');
  slider.min = state.sweep.startMHz; slider.max = state.sweep.stopMHz; slider.step = (state.sweep.stopMHz - state.sweep.startMHz) / 1000;
  if (document.activeElement !== slider) slider.value = state.frequencyMHz;
  const finiteLosses = sweep.filter((p) => Number.isFinite(p.returnLoss)).map((p) => p.returnLoss);
  const minRL = Math.min(0, Math.floor(Math.min(...finiteLosses, 0) / 10) * 10);
  const maxRL = Math.max(20, Math.min(60, Math.ceil(Math.max(...finiteLosses, 20) / 10) * 10));
  const x = (f) => 55 + 890 * (f - state.sweep.startMHz) / (state.sweep.stopMHz - state.sweep.startMHz);
  const y = (rl) => 146 - (Math.max(minRL, Math.min(maxRL, rl)) - minRL) / (maxRL - minRL) * 122;
  const path = sweep.map((p, index) => `${index === 0 ? 'M' : 'L'}${x(p.frequencyMHz).toFixed(2)} ${y(p.returnLoss).toFixed(2)}`).join(' ');
  const lines = [minRL, (maxRL + minRL) / 2, maxRL].map((v) => `<path d="M55 ${y(v)}H945" stroke="#e3e7ee"/><text x="43" y="${y(v) + 4}" text-anchor="end" fill="#687183">${v}</text>`).join('');
  const currentX = Math.max(55, Math.min(945, x(state.frequencyMHz)));
  $('#sweep-plot').innerHTML = `<svg viewBox="0 0 1000 185" role="img" aria-label="输入端回波损耗随频率变化" preserveAspectRatio="none"><g font-family="Helvetica,Arial,sans-serif" font-size="11">${lines}<text x="55" y="12" fill="#687183">回波损耗 / dB</text><path d="${path}" fill="none" stroke="#002fa7" stroke-width="2.5" vector-effect="non-scaling-stroke"/><path d="M${currentX} 24V146" stroke="#002fa7" stroke-dasharray="3 5" opacity=".5"/><text x="55" y="171" fill="#687183">${number(state.sweep.startMHz, 3)} MHz</text><text x="500" y="171" fill="#687183" text-anchor="middle">${number((state.sweep.startMHz + state.sweep.stopMHz) / 2, 3)} MHz</text><text x="945" y="171" fill="#687183" text-anchor="end">${number(state.sweep.stopMHz, 3)} MHz</text></g></svg>`;
  const best = sweep.reduce((a, b) => a.returnLoss >= b.returnLoss ? a : b);
  $('#sweep-best').textContent = `采样最佳点 ${frequency(best.frequencyMHz)} · RL ${number(best.returnLoss)} dB`;
}

function configFor(key) {
  const param = parameters().find((p) => p.key === key);
  if (param) return { ...param, min: key === 'loadX' ? -1e9 : key === 'elementZ0' ? 0.01 : key === 'elementRef' ? 0.001 : 0, max: param.limit };
  const globals = {
    frequency: { label: '工作频率', unit: 'MHz', value: state.frequencyMHz, min: 0.001, max: 1e6 },
    z0: { label: '参考阻抗 Z₀', unit: 'Ω', value: state.z0, min: 0.01, max: 1e6 },
    sweepStart: { label: '扫描起始频率', unit: 'MHz', value: state.sweep.startMHz, min: 0.001, max: state.sweep.stopMHz - 0.000001 },
    sweepStop: { label: '扫描终止频率', unit: 'MHz', value: state.sweep.stopMHz, min: state.sweep.startMHz + 0.000001, max: 1e6 },
  };
  return globals[key];
}

function setValue(key, value, coalesce = '') {
  const config = configFor(key);
  if (!config || !Number.isFinite(value) || value < config.min || value > config.max) throw new Error(`数值范围：${number(config?.min, 6)} ～ ${number(config?.max, 6)} ${config?.unit ?? ''}`);
  const e = currentElement();
  if (key === 'loadR' || key === 'loadX') {
    const z = loadAt();
    const nextLoad = { re: key === 'loadR' ? value : z.re, im: key === 'loadX' ? value : z.im };
    if (!Number.isFinite(nextLoad.re) || nextLoad.re < 0 || nextLoad.re > 1e9 || !Number.isFinite(nextLoad.im) || Math.abs(nextLoad.im) > 1e9) throw new Error('请先把电阻 R 设置为有限的非负数，再编辑电抗 X；有源和开路数据仍可直接查看。');
    remember(coalesce);
    if (state.loadData) { state.loadData = null; toast('已切换为固定负载；可撤销恢复数据负载'); }
    state.load = nextLoad;
  } else { remember(coalesce);
  if (key === 'elementValue') e.value = value;
  else if (key === 'elementZ0') e.z0 = value;
  else if (key === 'elementRef') e.refMHz = value;
  else if (key === 'frequency') state.frequencyMHz = value;
  else if (key === 'z0') state.z0 = value;
  else if (key === 'sweepStart') state.sweep.startMHz = value;
  else if (key === 'sweepStop') state.sweep.stopMHz = value;
  }
  scheduleRender();
}

function openNumber(key) {
  const config = configFor(key);
  if (!config) return;
  keypad = { key, buffer: Number.isFinite(config.value) ? String(Number(config.value.toPrecision(10))) : '0', fresh: true };
  $('#number-title').textContent = config.label;
  $('#number-unit').textContent = config.unit;
  $('#number-output').textContent = keypad.buffer;
  $('#number-error').textContent = '';
  $('#number-dialog').showModal();
}
function keypadKey(key) {
  if (!keypad) return;
  let text = keypad.buffer;
  if (/^\d$/.test(key)) { if (keypad.fresh || text === '0') text = key; else if (text.length < 15) text += key; keypad.fresh = false; }
  else if (key === '.') { if (keypad.fresh) text = '0'; if (!text.includes('.')) text += '.'; keypad.fresh = false; }
  else if (key === 'sign') { text = text.startsWith('-') ? text.slice(1) : `-${text}`; keypad.fresh = false; }
  else if (key === 'clear') { text = '0'; keypad.fresh = true; }
  else if (key === 'backspace') { text = text.slice(0, -1); if (!text || text === '-') text = '0'; keypad.fresh = false; }
  else if (key === '×10' || key === '÷10') { text = String(Number((Number(text) * (key === '×10' ? 10 : 0.1)).toPrecision(10))); keypad.fresh = true; }
  keypad.buffer = text;
  $('#number-output').textContent = text;
  $('#number-error').textContent = '';
}
function applyNumber() {
  if (!keypad) return;
  try { setValue(keypad.key, Number(keypad.buffer)); $('#number-dialog').close(); keypad = null; } catch (error) { $('#number-error').textContent = error.message; }
}

function addElement(type) {
  if (!NAMES[type]) return;
  if (state.elements.length >= 64) return toast('最多支持 64 个元件');
  remember();
  const value = type.endsWith('R') ? 50 : type.endsWith('L') ? 10 : type.endsWith('C') ? 10 : type === 'line' ? 45 : 30;
  const element = { id: crypto.randomUUID(), type, value, enabled: true };
  if (['line', 'openStub', 'shortStub'].includes(type)) { element.z0 = state.z0; element.refMHz = state.frequencyMHz; }
  state.elements.push(element); selectedId = element.id; render();
  $(`[data-select="node:${element.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
}
function usePreset(name) {
  remember();
  const settings = { showAdmittance: state.showAdmittance, showVswr: state.showVswr };
  state = { ...clone(DEFAULT_PROJECT), ...settings };
  selectedId = null;
  if (name === 'matched') { state.name = '匹配负载'; state.load = { re: 50, im: 0 }; }
  else if (name === 'reactive') state.name = '感性负载';
  else if (name === 'lmatch') { state.name = 'L 型匹配示例'; state.load = { re: 25, im: 0 }; state.elements = [{ id: crypto.randomUUID(), type: 'seriesL', value: 25 / (2 * Math.PI * 100e6) * 1e9, enabled: true }, { id: crypto.randomUUID(), type: 'shuntC', value: 0.02 / (2 * Math.PI * 100e6) * 1e12, enabled: true }]; selectedId = state.elements.at(-1).id; }
  else if (name === 'quarter') { state.name = '四分之一波长变换'; state.load = { re: 100, im: 0 }; state.elements = [{ id: crypto.randomUUID(), type: 'line', value: 90, z0: Math.sqrt(50 * 100), refMHz: 100, enabled: true }]; selectedId = state.elements[0].id; }
  render();
}

function download(text, filename, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function cleanFilename(name) { return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 80) || 'smith-touch'; }

async function importFile(file) {
  if (file.size > 3 * 1024 * 1024) throw new Error('文件超过 3 MB，请导出较少的频点后重试');
  const text = await file.text();
  let project;
  let warnings = [];
  if (/\.s[12]p$/i.test(file.name)) {
    const data = parseTouchstone(text, file.name);
    if (data.points.some((p) => p.frequencyMHz === 0)) { data.points = data.points.filter((p) => p.frequencyMHz > 0); warnings.push('已忽略 0 Hz 的 DC 点，理想交流元件仅在正频率下计算。'); }
    if (!data.points.length) throw new Error('文件只有 DC 点，请提供正频率 S 参数');
    const frequencyMHz = data.points[Math.floor(data.points.length / 2)].frequencyMHz;
    const z = gammaToImpedance(interpolateTouchstone(data, frequencyMHz), data.z0);
    const safeLoad = Number.isFinite(z.re) && Number.isFinite(z.im) && z.re >= 0 ? z : { re: data.z0, im: 0 };
    const first = data.points[0].frequencyMHz;
    const last = data.points.at(-1).frequencyMHz;
    project = validateProject({ ...clone(DEFAULT_PROJECT), name: file.name, frequencyMHz, z0: data.z0, load: safeLoad, loadData: data, sweep: { enabled: data.points.length > 1, startMHz: first === last && first > 5e5 ? first / 2 : first, stopMHz: last > first ? last : Math.min(1e6, last * 2) } });
  } else if (/\.smc$/i.test(file.name)) {
    const parsed = parseSMC(text); warnings = parsed.warnings;
    project = validateProject({ ...clone(DEFAULT_PROJECT), ...parsed, name: file.name.replace(/\.smc$/i, ''), sweep: { enabled: !!parsed.loadData, startMHz: parsed.loadData?.points[0].frequencyMHz ?? parsed.frequencyMHz * 0.5, stopMHz: parsed.loadData?.points.at(-1).frequencyMHz ?? parsed.frequencyMHz * 2 } });
  } else if (/\.json$/i.test(file.name)) project = validateProject(JSON.parse(text));
  else throw new Error('请选择 .json、.s1p、.s2p 或 .SMC 文件');
  remember(); state = project; selectedId = state.elements.at(-1)?.id ?? null; render();
  if (warnings.length) { toast(`已导入，存在兼容提示：${warnings.join(' ')}`, 12000); }
  else toast(`已导入 ${file.name}`);
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.edit) openNumber(button.dataset.edit);
  else if (button.dataset.add) addElement(button.dataset.add);
  else if (button.dataset.select) { selectedId = button.dataset.select === 'load' ? null : button.dataset.select.slice(5); render(); }
  else if (button.dataset.preset) usePreset(button.dataset.preset);
  else if (button.dataset.key) keypadKey(button.dataset.key);
  else if (button.dataset.step) {
    const key = button.dataset.step;
    const p = parameters().find((item) => item.key === key);
    const config = configFor(key);
    const value = Math.min(config.max, Math.max(config.min, Number((p.value + +button.dataset.direction * p.step).toPrecision(10))));
    try { setValue(key, value, `step-${key}`); } catch (error) { toast(error.message); }
  } else if (button.dataset.stepSize) {
    const key = button.dataset.for;
    steps[key === 'elementValue' ? currentElement().type : key] = +button.dataset.stepSize;
    renderInspector();
  }
});
document.addEventListener('input', (event) => {
  if (event.target.dataset.range) { try { setValue(event.target.dataset.range, +event.target.value, `range-${event.target.dataset.range}`); } catch (error) { toast(error.message); } }
});
$('#frequency-slider').addEventListener('input', (event) => { remember('frequency-sweep'); state.frequencyMHz = +event.target.value; scheduleRender(); });
$('#number-dialog').addEventListener('keydown', (event) => {
  if (/^[0-9.]$/.test(event.key)) { event.preventDefault(); keypadKey(event.key); }
  else if (event.key === 'Backspace') { event.preventDefault(); keypadKey('backspace'); }
  else if (event.key === '-') { event.preventDefault(); keypadKey('sign'); }
  else if (event.key === 'Enter') { event.preventDefault(); applyNumber(); }
});
$('.close-keypad').addEventListener('click', () => { $('#number-dialog').close(); keypad = null; });
$('#apply-number').addEventListener('click', applyNumber);
$('#number-dialog').addEventListener('cancel', () => { keypad = null; });
$('#number-dialog form').addEventListener('submit', (e) => e.preventDefault());
$('#help-button').addEventListener('click', () => $('#help-dialog').showModal());
$('#close-help').addEventListener('click', () => $('#help-dialog').close());
// 手机隐藏顶部说明按钮，页脚补充入口，避免挤压主要操作。
const mobileHelp = document.createElement('button'); mobileHelp.className = 'text-button'; mobileHelp.textContent = '使用说明'; mobileHelp.addEventListener('click', () => $('#help-dialog').showModal()); $('.app-footer>div').prepend(mobileHelp);
$('#admittance-toggle').addEventListener('click', () => { remember(); state.showAdmittance = !state.showAdmittance; render(); });
$('#vswr-toggle').addEventListener('click', () => { remember(); state.showVswr = !state.showVswr; render(); });
$('#sweep-toggle').addEventListener('click', () => { remember(); state.sweep.enabled = !state.sweep.enabled; render(); });
$('#parameter-controls').addEventListener('click', (event) => { if (event.target.closest('#bypass-button')) { remember(); const e = currentElement(); e.enabled = e.enabled === false; render(); } });
$('#remove-element').addEventListener('click', () => { remember(); state.elements = state.elements.filter((e) => e.id !== selectedId); selectedId = state.elements.at(-1)?.id ?? null; render(); });
function move(direction) { const index = state.elements.findIndex((e) => e.id === selectedId); const next = index + direction; if (index < 0 || next < 0 || next >= state.elements.length) return; remember(); [state.elements[index], state.elements[next]] = [state.elements[next], state.elements[index]]; render(); }
$('#move-left').addEventListener('click', () => move(-1));
$('#move-right').addEventListener('click', () => move(1));
$('#reset-button').addEventListener('click', () => { remember(); state = clone(DEFAULT_PROJECT); selectedId = null; render(); toast('已新建工程；可撤销返回上一个网络'); });
$('#undo-button').addEventListener('click', () => { if (!undo.length) return; redo.push(clone(state)); state = undo.pop(); if (!state.elements.some((e) => e.id === selectedId)) selectedId = null; lastEdit = { key: '', time: 0 }; render(); });
$('#redo-button').addEventListener('click', () => { if (!redo.length) return; undo.push(clone(state)); state = redo.pop(); if (!state.elements.some((e) => e.id === selectedId)) selectedId = null; lastEdit = { key: '', time: 0 }; render(); });
$('#match-button').addEventListener('click', () => {
  try {
    const result = suggestMatch(trace.at(-1).z, state.frequencyMHz, state.z0);
    if (!result.elements.length) return toast('输入端已匹配至参考阻抗');
    if (state.elements.length + result.elements.length > 64) return toast('元件数量超过上限，请移除部分元件');
    const items = result.elements.map((e) => ({ ...e, id: crypto.randomUUID() }));
    const candidate = validateProject({ ...state, elements: [...state.elements, ...items] });
    remember(); state = candidate; selectedId = items.at(-1).id; render(); toast(result.description);
  } catch (error) { toast(error.message, 6000); }
});
$('#save-button').addEventListener('click', () => { download(serializeProject(state), `${cleanFilename(state.name)}.json`); toast('工程已导出为 JSON，可在其他设备导入'); });
$('#import-button').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', async (event) => { const file = event.target.files[0]; if (!file) return; try { await importFile(file); } catch (error) { toast(`导入失败：${error.message}`, 8000); } finally { event.target.value = ''; } });
$('#export-svg').addEventListener('click', () => download(chart.exportSvg(), `${cleanFilename(state.name)}.svg`, 'image/svg+xml'));
$('#export-csv').addEventListener('click', () => { const rows = ['frequency_MHz,R_ohm,X_ohm,gamma_re,gamma_im,VSWR,return_loss_dB', ...sweep.map((p) => [p.frequencyMHz, p.z.re, p.z.im, p.gamma.re, p.gamma.im, p.vswr, p.returnLoss].join(','))]; download(rows.join('\r\n'), `${cleanFilename(state.name)}-sweep.csv`, 'text/csv;charset=utf-8'); });
$('#share-button').addEventListener('click', async () => {
  try {
    const encoded = encodeProject(state);
    if (encoded.length > 14000) return toast('工程频点较多，请使用“保存工程”下载 JSON 分享');
    const url = new URL(location.href); url.hash = `project=${encoded}`;
    await navigator.clipboard.writeText(url.href);
    toast('已复制包含当前参数的工程链接；接收方可直接打开');
  } catch { toast('无法访问剪贴板，请使用“保存工程”下载 JSON'); }
});
document.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !document.querySelector('dialog[open]')) { event.preventDefault(); $(event.shiftKey ? '#redo-button' : '#undo-button').click(); } });
window.addEventListener('pagehide', () => { try { localStorage.setItem(STORAGE_KEY, serializeProject(state)); } catch { /* 存储限制在界面中提示。 */ } });

try {
  const shared = new URLSearchParams(location.hash.slice(1)).get('project');
  if (shared) { state = decodeProject(shared); toast('已载入分享的工程，修改会保存在当前设备'); history.replaceState(null, '', location.pathname + location.search); }
  else { const saved = localStorage.getItem(STORAGE_KEY); if (saved) state = validateProject(JSON.parse(saved)); }
} catch (error) { toast(`未恢复工程：${error.message}。已打开新工程。`, 7000); }
selectedId = state.elements.at(-1)?.id ?? null;
render();
if ('serviceWorker' in navigator && !['localhost', '127.0.0.1'].includes(location.hostname)) navigator.serviceWorker.register('./sw.js').catch(() => { $('#local-status').textContent = '离线缓存未启用，工程仍会自动保存'; });
