import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROJECT, validateProject, encodeProject, decodeProject, serializeProject,
} from '../src/project.js';

const project = (changes = {}) => ({ ...structuredClone(DEFAULT_PROJECT), ...changes });
const data = (changes = {}) => ({
  name: '晶体管 S11.s2p', ports: 2, z0: 50,
  points: [{ frequencyMHz: 50, gamma: { re: 0.2, im: -0.4 } }, { frequencyMHz: 100, gamma: { re: 0.1, im: 0.3 } }],
  ...changes,
});

test('空配置补足默认值，返回全新对象且不会修改默认配置', () => {
  const normalized = validateProject({});
  assert.deepEqual(normalized, DEFAULT_PROJECT);
  normalized.load.re = 80;
  normalized.sweep.startMHz = 80;
  normalized.elements.push({});
  assert.equal(DEFAULT_PROJECT.load.re, 25);
  assert.equal(DEFAULT_PROJECT.sweep.startMHz, 50);
  assert.equal(DEFAULT_PROJECT.elements.length, 0);
});

test('额外字段被剔除，嵌套对象完全复制', () => {
  const source = project({ name: '  教学匹配网络  ', loadData: data(), secret: '不应保留' });
  source.load.secret = '不应保留';
  source.loadData.points[0].secret = '不应保留';
  const normalized = validateProject(source);
  assert.equal(normalized.name, '教学匹配网络');
  assert.equal('secret' in normalized, false);
  assert.equal('secret' in normalized.load, false);
  assert.equal('secret' in normalized.loadData.points[0], false);
  normalized.loadData.points[0].gamma.re = 0.9;
  assert.equal(source.loadData.points[0].gamma.re, 0.2);
});

test('九种理想元件均可接受；补齐启用状态和传输线参考参数', () => {
  const types = ['seriesR', 'seriesL', 'seriesC', 'shuntR', 'shuntL', 'shuntC', 'line', 'openStub', 'shortStub'];
  const normalized = validateProject(project({ elements: types.map((type) => ({ type, value: 1 })) }));
  assert.equal(normalized.elements.length, 9);
  for (const element of normalized.elements) assert.equal(element.enabled, true);
  for (const element of normalized.elements.slice(6)) {
    assert.equal(element.z0, 50);
    assert.equal(element.refMHz, 100);
  }
  assert.equal('z0' in normalized.elements[0], false);
});

test('缺失或重复的元件标识自动补唯一值，保留合法既有标识', () => {
  const elements = [
    { id: 'element-2', type: 'seriesR', value: 1 },
    { id: 'element-2', type: 'seriesL', value: 2 },
    { type: 'seriesC', value: 3 },
    { id: 'custom-id_1', type: 'line', value: 20 },
  ];
  const normalized = validateProject(project({ elements })).elements;
  assert.equal(new Set(normalized.map((element) => element.id)).size, 4);
  assert.equal(normalized[0].id, 'element-2');
  assert.equal(normalized[3].id, 'custom-id_1');
});

test('项目和阻抗拒绝 null、数组、非有限数和字符串数字', () => {
  for (const value of [null, [], 'value', 4]) assert.throws(() => validateProject(value), /项目必须是对象/);
  for (const frequencyMHz of [null, NaN, Infinity, '100', 0, -1]) {
    assert.throws(() => validateProject(project({ frequencyMHz })), /频率/);
  }
  for (const load of [null, [], { re: -1, im: 0 }, { re: 0, im: NaN }, { re: Infinity, im: 0 }]) {
    assert.throws(() => validateProject(project({ load })), /负载/);
  }
});

test('数值边界包含端点，越界值明确拒绝', () => {
  const valid = validateProject(project({
    frequencyMHz: 0.001, z0: 0.01, load: { re: 1e9, im: -1e9 },
    elements: [{ type: 'line', value: 1e9, z0: 1e6, refMHz: 1e6 }],
    sweep: { enabled: false, startMHz: 0.001, stopMHz: 1e6 },
  }));
  assert.equal(valid.load.re, 1e9);
  assert.throws(() => validateProject(project({ frequencyMHz: 1e6 + 1 })), /频率/);
  assert.throws(() => validateProject(project({ z0: 0.009 })), /参考阻抗/);
  assert.throws(() => validateProject(project({ load: { re: 0, im: 1e9 + 1 } })), /负载电抗/);
});

test('元件坏类型、坏数值和非法标识被拒绝', () => {
  for (const element of [null, { type: 'script', value: 1 }, { type: 'seriesL', value: NaN },
    { type: 'seriesR', value: -1 }, { type: 'seriesC', value: '4' },
    { id: '\"><img src=x>', type: 'seriesR', value: 1 },
    { type: 'line', value: 90, z0: 0 }, { type: 'openStub', value: 30, refMHz: Infinity },
    { type: 'shortStub', value: 90, enabled: 'false' }]) {
    assert.throws(() => validateProject(project({ elements: [element] })), /元件/);
  }
});

test('元件数量上限为 64', () => {
  const elements = Array.from({ length: 64 }, () => ({ type: 'seriesR', value: 0 }));
  assert.equal(validateProject(project({ elements })).elements.length, 64);
  elements.push({ type: 'seriesR', value: 1 });
  assert.throws(() => validateProject(project({ elements })), /64/);
});

test('扫频范围严格升序，显示设置必须是布尔值', () => {
  for (const sweep of [null, { enabled: true, startMHz: 100, stopMHz: 100 },
    { enabled: true, startMHz: 200, stopMHz: 100 }, { enabled: 1, startMHz: 50, stopMHz: 100 }]) {
    assert.throws(() => validateProject(project({ sweep })), /扫频/);
  }
  assert.throws(() => validateProject(project({ showAdmittance: 1 })), /导纳/);
  assert.throws(() => validateProject(project({ showVswr: null })), /驻波比/);
});

test('Touchstone 允许主动器件 S11，手动负载仍要求非负电阻', () => {
  const loadData = data({ points: [{ frequencyMHz: 50, gamma: { re: 1.2, im: -0.4 } }] });
  assert.equal(validateProject(project({ loadData })).loadData.points[0].gamma.re, 1.2);
  assert.throws(() => validateProject(project({ load: { re: -50, im: 0 } })), /负载电阻/);
});

test('Touchstone 拒绝非法端口、空数据、降序、重复和非有限系数', () => {
  for (const loadData of [data({ ports: 3 }), data({ z0: 0 }), data({ points: [] }),
    data({ points: [{ frequencyMHz: 100, gamma: { re: 0, im: 0 } }, { frequencyMHz: 50, gamma: { re: 0, im: 0 } }] }),
    data({ points: [{ frequencyMHz: 100, gamma: { re: 0, im: 0 } }, { frequencyMHz: 100, gamma: { re: 1, im: 0 } }] }),
    data({ points: [{ frequencyMHz: 100, gamma: { re: NaN, im: 0 } }] })]) {
    assert.throws(() => validateProject(project({ loadData })), /Touchstone|反射系数/);
  }
});

test('Touchstone 频点上限为 10001', () => {
  const points = Array.from({ length: 10001 }, (_, index) => ({ frequencyMHz: index + 1, gamma: { re: 0, im: 0 } }));
  assert.equal(validateProject(project({ loadData: data({ points }) })).loadData.points.length, 10001);
  points.push({ frequencyMHz: 10002, gamma: { re: 0, im: 0 } });
  assert.throws(() => validateProject(project({ loadData: data({ points }) })), /10001/);
});

test('HTML 字符保持普通文字，原型污染字段无法进入结果', () => {
  const name = '<img src=x onerror=alert(1)> & 中文';
  assert.equal(validateProject(project({ name })).name, name);
  const malicious = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
  const normalized = validateProject(malicious);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.hasOwn(normalized, '__proto__'), false);
  assert.equal(Object.hasOwn(normalized, 'constructor'), false);
  assert.throws(() => validateProject(project({ name: '坏\u0000名称' })), /控制字符/);
  assert.throws(() => validateProject(project({ name: ' '.repeat(20) })), /项目名称/);
});

test('中文、符号和嵌套数据通过 Base64URL 完整往返', () => {
  const source = project({ name: '微波匹配 / 第三课 Ω <50>', elements: [{ type: 'seriesL', value: 14.5 }], loadData: data() });
  const payload = encodeProject(source);
  assert.match(payload, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeProject(payload), validateProject(source));
  assert.equal(decodeProject(payload).name, source.name);
});

test('大数据编码按块处理，不会出现参数栈溢出', () => {
  const points = Array.from({ length: 10001 }, (_, index) => ({ frequencyMHz: index + 1, gamma: { re: index / 20000, im: 0.25 } }));
  const payload = encodeProject(project({ loadData: data({ points }) }));
  const normalized = decodeProject(payload);
  assert.equal(normalized.loadData.points.length, 10001);
  assert.deepEqual(normalized.loadData.points.at(-1), points.at(-1));
});

test('序列化包含格式和版本，未来版本会被清晰拒绝', () => {
  const serialized = JSON.parse(serializeProject(DEFAULT_PROJECT));
  assert.equal(serialized.format, 'smith-touch');
  assert.equal(serialized.version, 1);
  assert.deepEqual(validateProject(serialized), DEFAULT_PROJECT);
  assert.throws(() => validateProject({ ...serialized, version: 2 }), /更高版本/);
  assert.throws(() => validateProject({ ...serialized, version: '1' }), /版本/);
});

test('损坏、非法字符、无效 UTF-8 和非 JSON 分享内容均被拒绝', () => {
  for (const payload of [null, '', 'a', '%%%unsafe', 'abcd=', '_w', btoa('not json').replace(/=+$/u, '')]) {
    assert.throws(() => decodeProject(payload), /分享项目/);
  }
  assert.throws(() => decodeProject('a'.repeat(4_000_001)), /过大/);
});
