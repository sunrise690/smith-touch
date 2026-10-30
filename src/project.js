const ELEMENT_TYPES = new Set([
  'seriesR', 'seriesL', 'seriesC', 'shuntR', 'shuntL', 'shuntC',
  'line', 'openStub', 'shortStub',
]);
const LINE_TYPES = new Set(['line', 'openStub', 'shortStub']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const field = (object, key, fallback) => own(object, key) && object[key] !== undefined ? object[key] : fallback;

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export const DEFAULT_PROJECT = deepFreeze({
  name: '新建匹配网络',
  frequencyMHz: 100,
  z0: 50,
  load: { re: 25, im: 25 },
  elements: [],
  loadData: null,
  sweep: { enabled: false, startMHz: 50, stopMHz: 200 },
  showAdmittance: false,
  showVswr: true,
});

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label}必须是对象`);
  }
  return value;
}

function numeric(value, label, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label}必须是有限数值`);
  }
  if (value < minimum || value > maximum) {
    throw new RangeError(`${label}应在 ${minimum} 至 ${maximum} 之间`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function boolean(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`${label}必须为布尔值`);
  return value;
}

function text(value, label, maximum) {
  if (typeof value !== 'string') throw new TypeError(`${label}必须是文字`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new RangeError(`${label}需包含 1 至 ${maximum} 个字符`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`${label}不能包含控制字符`);
  }
  return normalized;
}

const frequency = (value, label = '频率') => numeric(value, label, 0.001, 1e6);
const referenceImpedance = (value, label = '参考阻抗') => numeric(value, label, 0.01, 1e6);

function normalizeLoadData(value) {
  if (value === null) return null;
  const source = record(value, 'Touchstone 数据');
  if (source.ports !== 1 && source.ports !== 2) throw new RangeError('Touchstone 端口数只支持 1 或 2');
  if (!Array.isArray(source.points) || source.points.length === 0 || source.points.length > 10001) {
    throw new RangeError('Touchstone 数据需包含 1 至 10001 个频点');
  }
  let previousFrequency = -Infinity;
  const points = source.points.map((point, index) => {
    record(point, `第 ${index + 1} 个 Touchstone 频点`);
    const frequencyMHz = frequency(point.frequencyMHz, `第 ${index + 1} 个频点的频率`);
    if (frequencyMHz <= previousFrequency) throw new RangeError('Touchstone 频率必须严格升序，不能重复');
    previousFrequency = frequencyMHz;
    const gamma = record(point.gamma, `第 ${index + 1} 个频点的反射系数`);
    // Active-device S11 may legitimately lie outside the unit disk.
    return {
      frequencyMHz,
      gamma: {
        re: numeric(gamma.re, '反射系数实部', -Number.MAX_VALUE, Number.MAX_VALUE),
        im: numeric(gamma.im, '反射系数虚部', -Number.MAX_VALUE, Number.MAX_VALUE),
      },
    };
  });
  return {
    name: text(field(source, 'name', '导入的 Touchstone'), 'Touchstone 名称', 180),
    ports: source.ports,
    z0: referenceImpedance(source.z0, 'Touchstone 参考阻抗'),
    points,
  };
}

/** Validate external project input and create a fresh, explicitly whitelisted object. */
export function validateProject(value) {
  const source = record(value, '项目');
  if (own(source, 'version') && source.version !== undefined) {
    if (typeof source.version !== 'number' || !Number.isInteger(source.version) || source.version < 1) {
      throw new TypeError('项目版本必须为正整数');
    }
    if (source.version > 1) throw new RangeError('此项目使用更高版本格式，当前仅支持版本 1');
  }
  const name = text(field(source, 'name', DEFAULT_PROJECT.name), '项目名称', 120);
  const frequencyMHz = frequency(field(source, 'frequencyMHz', DEFAULT_PROJECT.frequencyMHz));
  const z0 = referenceImpedance(field(source, 'z0', DEFAULT_PROJECT.z0));
  const inputLoad = record(field(source, 'load', DEFAULT_PROJECT.load), '负载阻抗');
  const load = {
    re: numeric(inputLoad.re, '负载电阻', 0, 1e9),
    im: numeric(inputLoad.im, '负载电抗', -1e9, 1e9),
  };
  const inputElements = field(source, 'elements', DEFAULT_PROJECT.elements);
  if (!Array.isArray(inputElements) || inputElements.length > 64) {
    throw new RangeError('匹配网络需为数组，最多支持 64 个元件');
  }
  const usedIds = new Set();
  const elements = inputElements.map((element, index) => {
    record(element, `第 ${index + 1} 个元件`);
    if (!ELEMENT_TYPES.has(element.type)) throw new TypeError(`第 ${index + 1} 个元件类型不受支持`);
    let id = field(element, 'id', null);
    if (id !== null && (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(id))) {
      throw new TypeError(`第 ${index + 1} 个元件的标识只能包含字母、数字、下划线或短横线`);
    }
    if (id === null || usedIds.has(id)) {
      const prefix = `element-${index + 1}`;
      id = prefix;
      let suffix = 2;
      while (usedIds.has(id)) id = `${prefix}-${suffix++}`;
    }
    usedIds.add(id);
    const normalized = {
      id,
      type: element.type,
      value: numeric(element.value, `第 ${index + 1} 个元件数值`, 0, 1e9),
      enabled: boolean(field(element, 'enabled', true), `第 ${index + 1} 个元件的启用状态`),
    };
    if (LINE_TYPES.has(element.type)) {
      normalized.z0 = referenceImpedance(field(element, 'z0', z0), `第 ${index + 1} 个元件的特性阻抗`);
      normalized.refMHz = frequency(field(element, 'refMHz', frequencyMHz), `第 ${index + 1} 个元件的电长度参考频率`);
    }
    return normalized;
  });
  const inputSweep = record(field(source, 'sweep', DEFAULT_PROJECT.sweep), '扫频设置');
  const sweep = {
    enabled: boolean(field(inputSweep, 'enabled', false), '扫频启用状态'),
    startMHz: frequency(field(inputSweep, 'startMHz', DEFAULT_PROJECT.sweep.startMHz), '扫频起始频率'),
    stopMHz: frequency(field(inputSweep, 'stopMHz', DEFAULT_PROJECT.sweep.stopMHz), '扫频终止频率'),
  };
  if (sweep.startMHz >= sweep.stopMHz) throw new RangeError('扫频起始频率必须小于终止频率');
  return {
    name, frequencyMHz, z0, load, elements,
    loadData: normalizeLoadData(field(source, 'loadData', null)),
    sweep,
    showAdmittance: boolean(field(source, 'showAdmittance', DEFAULT_PROJECT.showAdmittance), '导纳网格显示状态'),
    showVswr: boolean(field(source, 'showVswr', DEFAULT_PROJECT.showVswr), '驻波比圆显示状态'),
  };
}

export function serializeProject(project) {
  return JSON.stringify({ format: 'smith-touch', version: 1, ...validateProject(project) }, null, 2);
}

export function encodeProject(project) {
  const bytes = new TextEncoder().encode(serializeProject(project));
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

export function decodeProject(payload) {
  if (typeof payload !== 'string' || !payload || payload.length > 4_000_000
    || !/^[A-Za-z0-9_-]+$/u.test(payload) || payload.length % 4 === 1) {
    throw new TypeError('分享项目内容不是有效的 Base64URL 编码，或内容过大');
  }
  let project;
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - payload.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    project = JSON.parse(json);
  } catch {
    throw new TypeError('分享项目无法解析，请检查链接内容是否完整');
  }
  return validateProject(project);
}
