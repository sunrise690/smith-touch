import test from 'node:test';
import assert from 'node:assert/strict';
import {
  complex as c, add, sub, mul, div, mag, phase, impedanceToGamma, gammaToImpedance,
  metrics, applyElement, networkTrace, sweepNetwork, parseTouchstone, interpolateTouchstone,
} from '../src/rf.js';

const close = (actual, expected, tolerance = 1e-10) => {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} ≈ ${expected}`);
};
const sameComplex = (actual, expected, tolerance = 1e-10) => {
  close(actual.re, expected.re, tolerance);
  close(actual.im, expected.im, tolerance);
};
const element = (type, value, extra = {}) => ({ id: type, type, value, ...extra });

test('复数算术与缩放除法', () => {
  sameComplex(add(c(2, 3), c(5, -2)), c(7, 1));
  sameComplex(sub(c(2, 3), c(5, -2)), c(-3, 5));
  sameComplex(mul(c(2, 3), c(5, -2)), c(16, 11));
  sameComplex(div(c(2, 3), c(5, -2)), c(4 / 29, 19 / 29));
  sameComplex(div(c(1e300, 1e300), c(1e300, -1e300)), c(0, 1));
  close(mag(c(3, 4)), 5);
  close(phase(c(0, 1)), Math.PI / 2);
});

test('开路、短路、匹配点与阻抗反射系数往返', () => {
  sameComplex(impedanceToGamma(c(50)), c());
  sameComplex(impedanceToGamma(c()), c(-1));
  sameComplex(impedanceToGamma(c(Infinity)), c(1));
  assert.equal(gammaToImpedance(c(1)).re, Infinity);
  sameComplex(gammaToImpedance(c(-1)), c());
  for (const z0 of [25, 50, 75]) {
    for (const z of [c(24, 6.94), c(100, -75), c(0, 100), c(1e6, 1e5)]) {
      sameComplex(gammaToImpedance(impedanceToGamma(z, z0), z0), z, 1e-8);
    }
  }
  assert.throws(() => impedanceToGamma(c(50), 0), /参考阻抗/);
  assert.throws(() => gammaToImpedance(c(NaN)), /有限复数/);
});

test('指标的已知结果与无穷边界', () => {
  const matched = metrics(c(50));
  assert.equal(matched.vswr, 1);
  assert.equal(matched.returnLoss, Infinity);
  close(matched.mismatchLoss, 0);
  sameComplex(matched.admittance, c(0.02));
  const doubled = metrics(c(100));
  close(doubled.vswr, 2);
  close(doubled.returnLoss, 20 * Math.log10(3));
  close(doubled.mismatchLoss, -10 * Math.log10(8 / 9));
  assert.equal(metrics(c()).vswr, Infinity);
  assert.equal(metrics(c(Infinity)).vswr, Infinity);
  assert.equal(metrics(c(0, 100)).q, Infinity);
  close(metrics(c(50, -25)).q, 0.5);
});

test('串联 RLC 单位换算及并联元件', () => {
  const f = 100;
  const omega = 2 * Math.PI * f * 1e6;
  sameComplex(applyElement(c(50), element('seriesR', 25), f), c(75));
  sameComplex(applyElement(c(50), element('seriesL', 10), f), c(50, omega * 10e-9));
  sameComplex(applyElement(c(50), element('seriesC', 10), f), c(50, -1 / (omega * 10e-12)));
  sameComplex(applyElement(c(50), element('shuntR', 50), f), c(25));
  const capacitive = div(c(1), c(0.02, omega * 20e-12));
  sameComplex(applyElement(c(50), element('shuntC', 20), f), capacitive);
  const inductive = div(c(1), c(0.02, -1 / (omega * 20e-9)));
  sameComplex(applyElement(c(50), element('shuntL', 20), f), inductive);
  assert.equal(applyElement(c(50), element('seriesC', 0), f).re, Infinity);
  sameComplex(applyElement(c(50), element('shuntL', 0), f), c());
  sameComplex(applyElement(c(50), element('shuntC', 0), f), c(50));
  sameComplex(applyElement(c(Infinity), element('shuntR', 100), f), c(100));
  sameComplex(applyElement(c(50), element('seriesL', 10, { enabled: false }), f), c(50));
  assert.throws(() => applyElement(c(50), element('seriesC', -1), f), /非负/);
  assert.throws(() => applyElement(c(50), element('unknown', 1), f), /不支持/);
  assert.throws(() => applyElement(c(50), element('seriesR', 1), 0), /频率/);
});

test('无损线：四分之一波阻抗反转、半波重复、参考频率缩放', () => {
  sameComplex(applyElement(c(100), element('line', 90, { z0: 50 }), 100), c(25));
  sameComplex(applyElement(c(30, 20), element('line', 180, { z0: 75 }), 100), c(30, 20));
  assert.equal(applyElement(c(), element('line', 90), 100).re, Infinity);
  sameComplex(applyElement(c(Infinity), element('line', 90), 100), c());
  sameComplex(applyElement(c(100), element('line', 45, { refMHz: 100 }), 200), c(25));
  const before = impedanceToGamma(c(25, 30));
  const after = impedanceToGamma(applyElement(c(25, 30), element('line', 27), 100));
  close(mag(before), mag(after));
});

test('开路与短路并联支节，以及谐振奇点', () => {
  sameComplex(applyElement(c(50), element('openStub', 45), 100), c(25, -25));
  sameComplex(applyElement(c(50), element('shortStub', 45), 100), c(25, 25));
  sameComplex(applyElement(c(50), element('openStub', 0), 100), c(50));
  sameComplex(applyElement(c(50), element('openStub', 90), 100), c());
  sameComplex(applyElement(c(50), element('shortStub', 0), 100), c());
  sameComplex(applyElement(c(50), element('shortStub', 90), 100), c(50));
  // 45° + 50Ω 的短路支节抵消同阻抗开路支节导纳。
  const first = applyElement(c(50), element('openStub', 45), 100);
  sameComplex(applyElement(first, element('shortStub', 45), 100), c(50));
});

test('独立 ABCD 矩阵基线交叉检验混合网络', () => {
  // 基线单独使用 (A Z + B)/(C Z + D)，不调用 applyElement 的等效导纳/反射系数算法。
  function transform(z, A, B, C, D) {
    return div(add(mul(A, z), B), add(mul(C, z), D));
  }
  const fMHz = 145;
  const omega = 2 * Math.PI * fMHz * 1e6;
  const load = c(23, -41);
  const network = [element('seriesL', 15), element('shuntC', 4.7), element('line', 37, { z0: 75 }), element('shortStub', 65, { z0: 60 }), element('seriesR', 2)];
  let expected = cloneForTest(load);
  expected = transform(expected, c(1), c(0, omega * 15e-9), c(), c(1));
  expected = transform(expected, c(1), c(), c(0, omega * 4.7e-12), c(1));
  const t = 37 * Math.PI / 180;
  expected = transform(expected, c(Math.cos(t)), c(0, 75 * Math.sin(t)), c(0, Math.sin(t) / 75), c(Math.cos(t)));
  expected = transform(expected, c(1), c(), c(0, -1 / (60 * Math.tan(65 * Math.PI / 180))), c(1));
  expected = transform(expected, c(1), c(2), c(), c(1));
  const trace = networkTrace(load, network, fMHz);
  sameComplex(trace.at(-1).z, expected);
  assert.equal(trace.length, network.length + 1);
  assert.equal(trace[0].elementId, null);
  assert.equal(trace[1].elementId, 'seriesL');
  assert.equal(networkTrace(load, [...network, element('seriesR', 20, { enabled: false })], fMHz).length, trace.length);
});

function cloneForTest(z) { return c(z.re, z.im); }

test('无损网络能量边界：正实负载始终位于单位圆内', () => {
  for (const f of [10, 100, 500, 1000]) {
    for (const z of [c(1, -100), c(50, 50), c(1000, 200)]) {
      const trace = networkTrace(z, [element('seriesL', 12), element('shuntC', 6.8), element('line', 25, { refMHz: 100 }), element('openStub', 11, { refMHz: 100 })], f);
      for (const point of trace) {
        assert.ok(point.z.re >= -1e-9);
        assert.ok(mag(point.gamma) <= 1 + 1e-12);
      }
    }
  }
});

test('扫频端点、中心谐振与随频负载', () => {
  const center = 100;
  const L = 100;
  const C = 1 / ((2 * Math.PI * center * 1e6) ** 2 * L * 1e-9) / 1e-12;
  const sweep = sweepNetwork(c(50), [element('seriesL', L), element('seriesC', C)], { startMHz: 50, stopMHz: 150, points: 101 });
  assert.equal(sweep[0].frequencyMHz, 50);
  assert.equal(sweep.at(-1).frequencyMHz, 150);
  close(sweep[50].vswr, 1);
  assert.ok(sweep[50].returnLoss > 250);
  assert.ok(sweep[0].vswr > 1);
  const variable = sweepNetwork(c(50), [], { startMHz: 10, stopMHz: 20, points: 3, loadAt: (f) => c(f) });
  sameComplex(variable[1].z, c(15));
  assert.throws(() => sweepNetwork(c(50), [], { startMHz: 100, stopMHz: 10 }), /终点/);
  assert.throws(() => sweepNetwork(c(50), [], { startMHz: 10, stopMHz: 100, points: 1 }), /点数/);
});

test('Touchstone RI、注释、频率单位和任意参考阻抗', () => {
  const data = parseTouchstone('! 测量\n# HZ S RI R 75\n100000000 .2 -.1 ! comment\n200000000 .4 .1', 'load.S1P');
  assert.equal(data.ports, 1);
  assert.equal(data.z0, 75);
  assert.equal(data.points[0].frequencyMHz, 100);
  sameComplex(data.points[0].gamma, c(0.2, -0.1));
  sameComplex(interpolateTouchstone(data, 150), c(0.3, 0));
  sameComplex(interpolateTouchstone(data, 1), c(0.2, -0.1));
  sameComplex(interpolateTouchstone(data, 1000), c(0.4, 0.1));
  assert.equal(parseTouchstone('# KHZ S RI R 50\n100000 0 0').points[0].frequencyMHz, 100);
});

test('Touchstone MA、DB、默认 GHz/MA 和 S2P 续行', () => {
  const ma = parseTouchstone('# MHZ S MA R 50\n100 .5 90');
  sameComplex(ma.points[0].gamma, c(0, 0.5));
  const db = parseTouchstone('# GHz S DB R 50\n1 -20 -90');
  close(db.points[0].frequencyMHz, 1000);
  sameComplex(db.points[0].gamma, c(0, -0.1));
  const defaults = parseTouchstone('0.1 .25 180');
  assert.equal(defaults.points[0].frequencyMHz, 100);
  sameComplex(defaults.points[0].gamma, c(-0.25));
  const twoPort = parseTouchstone('# MHz S RI R 50\n100 .1 .2 1 0\n0.01 0 .3 -.2\n200 .2 .4 1 0 0.01 0 .3 -.2', 'transistor.s2p');
  assert.equal(twoPort.ports, 2);
  assert.equal(twoPort.points.length, 2);
  sameComplex(twoPort.points[0].gamma, c(0.1, 0.2));
  sameComplex(twoPort.points[1].gamma, c(0.2, 0.4));
});

test('Touchstone 损坏/不支持的数据明确报错，排序无序频率', () => {
  for (const text of ['', '! only comments', '# MHz Z RI R 50\n1 0 0', '# MHz S RI R -50\n1 0 0', '# MHz S RI R 50\n1 0', '# MHz S RI R 50\nNaN 0 0', '# MHz S RI R 50\n1 0 0\n1 .2 .1', '[Version] 2.0', '# MHz S MA R 50\n1 -.2 0']) {
    assert.throws(() => parseTouchstone(text));
  }
  assert.throws(() => parseTouchstone('1 0 0', 'bad.csv'), /仅支持/);
  const data = parseTouchstone('# MHz S RI R 50\n200 .2 0\n100 .1 0');
  assert.deepEqual(data.points.map((p) => p.frequencyMHz), [100, 200]);
});
