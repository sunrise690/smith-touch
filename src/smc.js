const TYPE_MAP = {
  IS: ['seriesL', 1e9], IP: ['shuntL', 1e9],
  CS: ['seriesC', 1e12], CP: ['shuntC', 1e12],
  RS: ['seriesR', 1], RP: ['shuntR', 1],
  LS: ['line', 360], LPS: ['shortStub', 360], LPO: ['openStub', 360],
};

function number(text, label) {
  if (text === undefined || !String(text).trim()) throw new Error(`SMC 缺少 ${label}`);
  const value = Number(String(text).trim().replace(/[dD]/, 'E'));
  if (!Number.isFinite(value)) throw new Error(`SMC 的 ${label} 不是有限数值`);
  return value;
}

function positive(text, label) {
  const value = number(text, label);
  if (value <= 0) throw new Error(`SMC 的 ${label} 必须大于零`);
  return value;
}

function integer(text, label) {
  const value = number(text, label);
  if (!Number.isInteger(value) || value < 0 || value > 100000) throw new Error(`SMC 的 ${label} 不是合理的非负整数`);
  return value;
}

function parseSections(text) {
  if (typeof text !== 'string' || text.length > 5e6) throw new Error('SMC 文件为空或过大');
  const sections = new Map();
  let section;
  for (const originalLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const title = line.match(/^\[([^\]]+)\]$/);
    if (title) {
      const name = title[1].trim().toUpperCase();
      if (sections.has(name)) throw new Error(`SMC 含重复的 [${name}] 区段`);
      section = { singles: new Map(), indexed: new Map() };
      sections.set(name, section);
      continue;
    }
    if (!section) throw new Error('SMC 数据必须位于区段内');
    const pair = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!pair) throw new Error(`无法识别 SMC 行：${line.slice(0, 70)}`);
    const key = pair[1].toUpperCase();
    const value = pair[2].trim();
    // SMC 将 NR/START/Z0/WIDEBAND 写成单值，将 R/X/F/TYP 等写成 index,value。
    if (/^(NR|START|Z0|WIDEBAND)$/.test(key)) {
      section.singles.set(key, value);
    } else {
      const indexed = value.match(/^(\d+)\s*,\s*(.*)$/);
      if (!indexed) {
        section.singles.set(key, value);
      } else {
        if (!section.indexed.has(key)) section.indexed.set(key, new Map());
        section.indexed.get(key).set(Number(indexed[1]), indexed[2]);
      }
    }
  }
  return sections;
}

function gammaFromZ(z, z0) {
  const denominator = (z.re + z0) ** 2 + z.im ** 2;
  if (denominator === 0) throw new Error('SMC 负载位于 Γ 的奇点 Z = −Z₀');
  return {
    re: (z.re ** 2 - z0 ** 2 + z.im ** 2) / denominator,
    im: (2 * z0 * z.im) / denominator,
  };
}

/**
 * 导入 Smith V2.01 的文本 SMC 工程子集。
 * 仅使用已观察到的文本格式和公开电路关系，未复用原程序代码。
 */
export function parseSMC(text) {
  const sections = parseSections(text);
  const data = sections.get('DATAPOINTS');
  if (!data) throw new Error('不是支持的 SMC 工程：缺少 [DATAPOINTS]');
  const warnings = [];
  const count = integer(data.singles.get('NR'), '数据点 NR');
  if (!count) throw new Error('SMC 工程没有负载数据点');
  const selected = integer(data.singles.get('START') ?? '1', 'START') - 1;
  if (selected < 0 || selected >= count) throw new Error('SMC 的 START 超出数据点范围（START 从 1 开始）');
  const z0 = positive(sections.get('Z0')?.singles.get('Z0') ?? '50', 'Z₀');
  const indexedValue = (section, key, index) => section.indexed.get(key)?.get(index);
  const loads = [];
  for (let index = 0; index < count; index += 1) {
    const re = number(indexedValue(data, 'R', index), `R[${index}]`);
    const im = number(indexedValue(data, 'X', index), `X[${index}]`);
    const frequencyMHz = positive(indexedValue(data, 'F', index), `F[${index}]`) / 1e6;
    loads.push({ z: { re, im }, frequencyMHz });
  }
  const load = loads[selected].z;
  const frequencyMHz = loads[selected].frequencyMHz;
  const elements = [];
  const elementSection = sections.get('ELEMENTS');
  if (elementSection) {
    const elementCount = integer(elementSection.singles.get('NR') ?? '0', '元件 NR');
    for (let index = 0; index < elementCount; index += 1) {
      const rawType = indexedValue(elementSection, 'TYP', index)?.trim().toUpperCase();
      if (!rawType) throw new Error(`SMC 缺少元件 TYP[${index}]`);
      const mapping = TYPE_MAP[rawType];
      if (!mapping) {
        warnings.push(`元件 ${index + 1} 的类型 ${rawType} 暂不支持，已跳过；导入后的匹配网络不完整。`);
        continue;
      }
      const rawValue = number(indexedValue(elementSection, 'VAL', index), `VAL[${index}]`);
      const [type, scale] = mapping;
      if (rawValue < 0 || (/^[IC]/.test(rawType) && rawValue === 0)) {
        throw new Error(`SMC 元件 ${index + 1} 的数值不适用于无源匹配网络`);
      }
      const element = { id: `smc-${index + 1}`, type, value: rawValue * scale, enabled: true };
      if (/^L/.test(rawType)) {
        element.z0 = positive(indexedValue(elementSection, 'IMP', index), `IMP[${index}]`);
        element.refMHz = frequencyMHz;
        if (rawType === 'LPO') {
          warnings.push(`元件 ${index + 1} 按 LPO = 并联开路支节解释；该代号尚无原包实例可交叉核验。`);
        }
      }
      elements.push(element);
    }
  }

  const unsupportedOverlays = [
    ['STABILITY', '稳定圆'], ['GAIN', '增益圆'], ['NOISE', '噪声圆'],
    ['Q', 'Q 等值线'], ['VSWR', '驻波比覆盖圆'],
  ].filter(([key]) => sections.has(key)).map(([, label]) => label);
  if (unsupportedOverlays.length) warnings.push(`原工程包含${unsupportedOverlays.join('、')}；这些覆盖层暂不导入。`);
  if (sections.has('WIDEBAND')) warnings.push('原工程的宽带计算缓存不导入；网页版会根据负载数据与元件重新扫频。');
  const recognized = new Set(['DATAPOINTS', 'Z0', 'ELEMENTS', 'HISTORY', 'WIDEBAND', 'STABILITY', 'GAIN', 'NOISE', 'Q', 'VSWR']);
  for (const key of sections.keys()) {
    if (!recognized.has(key)) warnings.push(`区段 [${key}] 暂不支持，未导入。`);
  }
  const result = { name: 'SMC 工程', z0, frequencyMHz, load, elements, warnings };
  if (loads.length > 1) {
    result.loadData = {
      name: 'SMC 负载数据', ports: 1, z0,
      points: loads.map(({ z, frequencyMHz: f }) => ({ frequencyMHz: f, gamma: gammaFromZ(z, z0) }))
        .sort((a, b) => a.frequencyMHz - b.frequencyMHz),
    };
  }
  return result;
}
