import { complex, div } from './rf.js';

let matchSequence = 0;

function validate(z, fMHz, z0) {
  if (!z || !Number.isFinite(z.re) || !Number.isFinite(z.im)) {
    throw new RangeError('自动匹配需要有限阻抗，开路或无穷大阻抗无法使用两元件 L 匹配');
  }
  if (z.re <= 0) throw new RangeError('自动匹配需要正的负载电阻；纯无功、短路或负电阻无法无损匹配');
  if (!Number.isFinite(fMHz) || fMHz <= 0) throw new RangeError('匹配频率必须为正的有限数值');
  if (!Number.isFinite(z0) || z0 <= 0) throw new RangeError('参考阻抗必须为正的有限数值');
}

function component(kind, amount, omega, z0) {
  const threshold = kind === 'series' ? z0 * 1e-12 : 1e-12 / z0;
  if (Math.abs(amount) <= threshold) return null;
  let type;
  let value;
  if (kind === 'series') {
    type = amount > 0 ? 'seriesL' : 'seriesC';
    value = amount > 0 ? amount / omega * 1e9 : -1 / (omega * amount) * 1e12;
  } else {
    type = amount > 0 ? 'shuntC' : 'shuntL';
    value = amount > 0 ? amount / omega * 1e12 : -1 / (omega * amount) * 1e9;
  }
  if (!Number.isFinite(value) || value <= 0) throw new RangeError('阻抗数量级超出自动匹配的可计算范围');
  return { type, value, enabled: true };
}

/**
 * 在指定频率，以理想无损 L/C 将当前阻抗匹配至实参考阻抗。
 * 元件排列为从当前负载向信号源的顺序，保留完整精度供计算和后续微调。
 *
 * R≤Z₀：先使串联后的虚部为 ±√(R(Z₀−R))，再用并联电纳消去导纳虚部。
 * R>Z₀：先使导纳虚部为 ±√(G/Z₀−G²)，再用串联电抗消去阻抗虚部。
 * 两个根均尝试，优先选所需归一化电抗与电纳之和较小的一支。
 */
export function suggestMatch(z, fMHz, z0 = 50) {
  validate(z, fMHz, z0);
  const tolerance = z0 * 1e-12;
  if (Math.abs(z.re - z0) <= tolerance && Math.abs(z.im) <= tolerance) {
    return { elements: [], description: `当前阻抗已匹配至 ${z0} Ω，无需加入元件。` };
  }
  const r = z.re / z0;
  const x = z.im / z0;
  if (!Number.isFinite(r) || !Number.isFinite(x) || r === 0) throw new RangeError('阻抗数量级超出自动匹配的可计算范围');
  const omega = 2 * Math.PI * fMHz * 1e6;
  const candidates = [];
  for (const sign of [1, -1]) {
    let seriesX;
    let shuntB;
    let order;
    if (r <= 1) {
      const targetX = sign * Math.sqrt(r) * Math.sqrt(1 - r);
      seriesX = (targetX - x) * z0;
      shuntB = targetX / r / z0;
      order = ['series', 'shunt'];
    } else {
      const y = div(complex(1), complex(r, x));
      if (y.re <= 0 || !Number.isFinite(y.re)) throw new RangeError('阻抗数量级超出自动匹配的可计算范围');
      const targetB = sign * Math.sqrt(y.re) * Math.sqrt(Math.max(0, 1 - y.re));
      shuntB = (targetB - y.im) / z0;
      seriesX = targetB / y.re * z0;
      order = ['shunt', 'series'];
    }
    try {
      const components = {
        series: component('series', seriesX, omega, z0),
        shunt: component('shunt', shuntB, omega, z0),
      };
      const elements = order.map((kind) => components[kind]).filter(Boolean);
      const score = Math.abs(seriesX) / z0 + Math.abs(shuntB) * z0;
      if (Number.isFinite(score)) candidates.push({ elements, score, order });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  }
  if (!candidates.length) throw new RangeError('阻抗数量级超出自动匹配的可计算范围');
  candidates.sort((a, b) => a.score - b.score || a.elements.length - b.elements.length);
  const selected = candidates[0];
  const names = { seriesL: '串联电感', seriesC: '串联电容', shuntL: '并联电感', shuntC: '并联电容' };
  const batch = ++matchSequence;
  return {
    elements: selected.elements.map((item, index) => ({ id: `match-${batch}-${index + 1}`, ...item })),
    description: `从当前阻抗向信号源加入${selected.elements.map((item) => names[item.type]).join('、')}，在 ${fMHz} MHz 匹配至 ${z0} Ω。采用理想元件；实际器件需考虑损耗与寄生参数。`,
  };
}
