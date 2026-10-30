/**
 * 独立实现的射频计算内核。阻抗单位 Ω，频率 MHz，电感 nH，电容 pF。
 * 开路用 { re: Infinity, im: 0 } 表示；纯数学奇点由调用方显示为 ∞。
 */
export const complex = (re = 0, im = 0) => ({ re, im });
export const add = (a, b) => complex(a.re + b.re, a.im + b.im);
export const sub = (a, b) => complex(a.re - b.re, a.im - b.im);
export const mul = (a, b) => complex(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
export const mag = (a) => Math.hypot(a.re, a.im);
export const phase = (a) => Math.atan2(a.im, a.re);

const OPEN = () => complex(Infinity, 0);
const isOpen = (z) => !Number.isFinite(z.re) || !Number.isFinite(z.im);
const isZero = (z) => z.re === 0 && z.im === 0;
const clone = (z) => complex(z.re, z.im);

/** 使用分母归一化，避免直接计算 |b|² 导致溢出。 */
export function div(a, b) {
  if (isZero(b)) return OPEN();
  if (isOpen(b)) return isOpen(a) ? complex(NaN, NaN) : complex();
  if (isOpen(a)) return OPEN();
  const scale = Math.max(Math.abs(b.re), Math.abs(b.im));
  const br = b.re / scale;
  const bi = b.im / scale;
  const denominator = br * br + bi * bi;
  return complex(((a.re / scale) * br + (a.im / scale) * bi) / denominator,
    ((a.im / scale) * br - (a.re / scale) * bi) / denominator);
}

const inverse = (z) => isOpen(z) ? complex() : div(complex(1), z);

function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name}必须为正的有限数值`);
  return value;
}

function validImpedance(z) {
  if (!z || typeof z.re !== 'number' || typeof z.im !== 'number' || Number.isNaN(z.re) || Number.isNaN(z.im)) {
    throw new TypeError('阻抗必须包含有效的 re 和 im 数值');
  }
  return z;
}

export function impedanceToGamma(z, z0 = 50) {
  positive(z0, '参考阻抗');
  validImpedance(z);
  if (isOpen(z)) return complex(1);
  return div(sub(z, complex(z0)), add(z, complex(z0)));
}

export function gammaToImpedance(gamma, z0 = 50) {
  positive(z0, '参考阻抗');
  if (!gamma || !Number.isFinite(gamma.re) || !Number.isFinite(gamma.im)) throw new TypeError('反射系数必须为有限复数');
  if (gamma.re === 1 && gamma.im === 0) return OPEN();
  const normalized = div(add(complex(1), gamma), sub(complex(1), gamma));
  return complex(normalized.re * z0, normalized.im * z0);
}

export function metrics(z, z0 = 50) {
  const gamma = impedanceToGamma(z, z0);
  const rho = mag(gamma);
  return {
    gamma,
    vswr: rho >= 1 ? Infinity : (1 + rho) / (1 - rho),
    returnLoss: rho === 0 ? Infinity : -20 * Math.log10(rho),
    mismatchLoss: rho >= 1 ? Infinity : -10 * Math.log10(1 - rho * rho),
    q: isOpen(z) ? Infinity : z.re === 0 ? (z.im === 0 ? 0 : Infinity) : Math.abs(z.im / z.re),
    admittance: inverse(z),
  };
}

function parallel(z, branch) {
  if (isZero(z) || isZero(branch)) return complex();
  return inverse(add(inverse(z), inverse(branch)));
}

function shuntAdmittance(z, admittance) {
  if (isZero(z) || isOpen(admittance)) return complex();
  return inverse(add(inverse(z), admittance));
}

const ELEMENT_NAMES = {
  seriesR: '串联电阻', seriesL: '串联电感', seriesC: '串联电容',
  shuntR: '并联电阻', shuntL: '并联电感', shuntC: '并联电容',
  line: '传输线', openStub: '开路并联支节', shortStub: '短路并联支节',
};

/** 从负载向信号源依次加入理想元件；电长度按 refMHz 指定的频率缩放。 */
export function applyElement(z, element, fMHz, z0 = 50) {
  validImpedance(z);
  positive(fMHz, '频率');
  positive(z0, '参考阻抗');
  if (!element || !ELEMENT_NAMES[element.type]) throw new TypeError(`不支持的元件类型：${element?.type ?? '空'}`);
  if (element.enabled === false) return clone(z);
  const value = Number(element.value);
  if (!Number.isFinite(value) || value < 0) throw new RangeError('元件数值必须为非负有限数值');
  const omega = 2 * Math.PI * fMHz * 1e6;
  let branch;
  switch (element.type) {
    case 'seriesR': branch = complex(value); break;
    case 'seriesL': branch = complex(0, omega * value * 1e-9); break;
    case 'seriesC': branch = value === 0 ? OPEN() : complex(0, -1 / (omega * value * 1e-12)); break;
    case 'shuntR': return parallel(z, complex(value));
    case 'shuntL': return parallel(z, complex(0, omega * value * 1e-9));
    case 'shuntC': return shuntAdmittance(z, complex(0, omega * value * 1e-12));
    case 'line': {
      const lineZ0 = positive(element.z0 ?? z0, '传输线特性阻抗');
      const ref = positive(element.refMHz ?? fMHz, '电长度参考频率');
      const theta = value * (fMHz / ref) * Math.PI / 180;
      const gamma = impedanceToGamma(z, lineZ0);
      const rotated = mul(gamma, complex(Math.cos(-2 * theta), Math.sin(-2 * theta)));
      // 精确处理半波重复，防止开路因浮点 sin(2π) 变成巨大虚部。
      if (Math.abs(Math.sin(theta)) < 1e-14) return clone(z);
      if (Math.abs(Math.cos(theta)) < 1e-14 && isZero(z)) return OPEN();
      if (Math.abs(Math.cos(theta)) < 1e-14 && isOpen(z)) return complex();
      return gammaToImpedance(rotated, lineZ0);
    }
    case 'openStub':
    case 'shortStub': {
      const lineZ0 = positive(element.z0 ?? z0, '支节特性阻抗');
      const ref = positive(element.refMHz ?? fMHz, '电长度参考频率');
      const theta = value * (fMHz / ref) * Math.PI / 180;
      const sine = Math.sin(theta);
      const cosine = Math.cos(theta);
      if (element.type === 'openStub') {
        if (Math.abs(cosine) < 1e-14) return complex();
        return shuntAdmittance(z, complex(0, sine / cosine / lineZ0));
      }
      if (Math.abs(sine) < 1e-14) return complex();
      return shuntAdmittance(z, complex(0, -cosine / sine / lineZ0));
    }
  }
  if (isOpen(z) || isOpen(branch)) return OPEN();
  return add(z, branch);
}

export function networkTrace(load, elements = [], fMHz, z0 = 50) {
  positive(fMHz, '频率');
  let z = clone(validImpedance(load));
  const trace = [{ z: clone(z), gamma: impedanceToGamma(z, z0), label: '负载', elementId: null }];
  for (const [index, element] of elements.entries()) {
    if (element.enabled === false) continue;
    z = applyElement(z, element, fMHz, z0);
    trace.push({ z: clone(z), gamma: impedanceToGamma(z, z0), label: ELEMENT_NAMES[element.type], elementId: element.id ?? `element-${index + 1}` });
  }
  return trace;
}

export function sweepNetwork(load, elements = [], { startMHz, stopMHz, points = 101, z0 = 50, loadAt } = {}) {
  positive(startMHz, '扫频起点');
  positive(stopMHz, '扫频终点');
  if (stopMHz < startMHz) throw new RangeError('扫频终点不得小于起点');
  if (!Number.isInteger(points) || points < 2 || points > 10001) throw new RangeError('扫频点数必须为 2～10001 的整数');
  positive(z0, '参考阻抗');
  if (loadAt !== undefined && typeof loadAt !== 'function') throw new TypeError('loadAt 必须为阻抗函数');
  return Array.from({ length: points }, (_, index) => {
    const frequencyMHz = startMHz + (stopMHz - startMHz) * index / (points - 1);
    const trace = networkTrace(loadAt ? loadAt(frequencyMHz) : load, elements, frequencyMHz, z0);
    const z = trace[trace.length - 1].z;
    const m = metrics(z, z0);
    return { frequencyMHz, z, gamma: m.gamma, vswr: m.vswr, returnLoss: m.returnLoss };
  });
}

/** Touchstone 1.0：读取 S11；S2P 按 S11、S21、S12、S22 的标准顺序解析。 */
export function parseTouchstone(text, filename = 'data.s1p') {
  if (typeof text !== 'string') throw new TypeError('Touchstone 内容必须为文本');
  const extension = /\.s([12])p$/i.exec(filename);
  if (!extension) throw new Error('仅支持 Touchstone 1.0 的 .s1p 和 .s2p 文件');
  const ports = Number(extension[1]);
  let unit = 'GHZ';
  let format = 'MA';
  let z0 = 50;
  let sawOptions = false;
  let sawData = false;
  const tokens = [];
  for (const [index, original] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = original.split('!')[0].trim();
    if (!line) continue;
    if (line.startsWith('[')) throw new Error('暂不支持 Touchstone 2.0 关键字，请导出为 1.0 格式');
    if (line.startsWith('#')) {
      if (sawOptions || sawData) throw new Error(`第 ${index + 1} 行：选项行重复或位于数据之后`);
      sawOptions = true;
      const options = line.slice(1).trim().toUpperCase().split(/\s+/).filter(Boolean);
      for (let i = 0; i < options.length; i++) {
        const option = options[i];
        if (['HZ', 'KHZ', 'MHZ', 'GHZ'].includes(option)) unit = option;
        else if (['RI', 'MA', 'DB'].includes(option)) format = option;
        else if (option === 'S') { /* 默认网络参数 */ }
        else if (option === 'R') {
          z0 = Number(options[++i]);
          positive(z0, 'Touchstone 参考阻抗');
        } else throw new Error(`不支持的 Touchstone 选项：${option}（仅支持 S 参数）`);
      }
      continue;
    }
    sawData = true;
    for (const token of line.split(/\s+/)) {
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/.test(token)) throw new Error(`第 ${index + 1} 行包含非法数值：${token}`);
      const value = Number(token.replace(/[dD]/, 'e'));
      if (!Number.isFinite(value)) throw new Error(`第 ${index + 1} 行的数值超出范围`);
      tokens.push(value);
    }
  }
  const width = 1 + 2 * ports * ports;
  if (!tokens.length) throw new Error('Touchstone 文件不包含数据');
  if (tokens.length % width !== 0) throw new Error(`Touchstone 数据不完整：每个频点需要 ${width} 个数值`);
  const scale = { HZ: 1e-6, KHZ: 1e-3, MHZ: 1, GHZ: 1e3 }[unit];
  const data = [];
  for (let offset = 0; offset < tokens.length; offset += width) {
    const frequencyMHz = tokens[offset] * scale;
    if (frequencyMHz < 0 || !Number.isFinite(frequencyMHz)) throw new Error('频率必须为非负有限数值');
    const a = tokens[offset + 1];
    const b = tokens[offset + 2];
    let gamma;
    if (format === 'RI') gamma = complex(a, b);
    else {
      if (format === 'MA' && a < 0) throw new Error('MA 格式的幅度不得为负数');
      const magnitude = format === 'DB' ? 10 ** (a / 20) : a;
      const angle = b * Math.PI / 180;
      gamma = complex(magnitude * Math.cos(angle), magnitude * Math.sin(angle));
      if (!Number.isFinite(gamma.re) || !Number.isFinite(gamma.im)) throw new Error('S11 数值超出范围');
    }
    // 检查其余 S 参数的 MA 幅度，防止损坏的数据被默默接受。
    if (format === 'MA') {
      for (let pair = 1; pair <= ports * ports; pair++) {
        if (tokens[offset + pair * 2 - 1] < 0) throw new Error('MA 格式的幅度不得为负数');
      }
    }
    data.push({ frequencyMHz, gamma });
  }
  data.sort((a, b) => a.frequencyMHz - b.frequencyMHz);
  for (let i = 1; i < data.length; i++) {
    if (data[i].frequencyMHz === data[i - 1].frequencyMHz) throw new Error('Touchstone 包含重复频率；请移除重复点');
  }
  return { ports, z0, points: data, name: filename };
}

/** 在复数平面线性插值 S11；频带之外返回最近端点。 */
export function interpolateTouchstone(data, fMHz) {
  if (!data?.points?.length) throw new Error('Touchstone 数据为空');
  if (!Number.isFinite(fMHz)) throw new Error('插值频率必须为有限数值');
  const points = data.points;
  if (fMHz <= points[0].frequencyMHz) return clone(points[0].gamma);
  if (fMHz >= points[points.length - 1].frequencyMHz) return clone(points[points.length - 1].gamma);
  let left = 0;
  let right = points.length - 1;
  while (right - left > 1) {
    const middle = Math.floor((left + right) / 2);
    if (points[middle].frequencyMHz <= fMHz) left = middle;
    else right = middle;
  }
  const fraction = (fMHz - points[left].frequencyMHz) / (points[right].frequencyMHz - points[left].frequencyMHz);
  return add(points[left].gamma, mul(sub(points[right].gamma, points[left].gamma), complex(fraction)));
}
