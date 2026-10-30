import test from 'node:test';
import assert from 'node:assert/strict';
import { complex as c, applyElement, impedanceToGamma, mag } from '../src/rf.js';
import { suggestMatch } from '../src/match.js';

function verifyMatch(z, fMHz, z0 = 50) {
  const solution = suggestMatch(z, fMHz, z0);
  assert.ok(solution.elements.length <= 2);
  assert.equal(typeof solution.description, 'string');
  assert.ok(solution.description.length > 0);
  let result = z;
  for (const element of solution.elements) {
    assert.equal(element.enabled, true);
    assert.ok(Number.isFinite(element.value) && element.value > 0);
    assert.ok(['seriesL', 'seriesC', 'shuntL', 'shuntC'].includes(element.type));
    assert.equal(typeof element.id, 'string');
    result = applyElement(result, element, fMHz, z0);
  }
  assert.ok(Math.abs(result.re - z0) < z0 * 1e-9, `实部 ${result.re}，目标 ${z0}，负载 ${JSON.stringify(z)}`);
  assert.ok(Math.abs(result.im) < z0 * 1e-9, `残余虚部 ${result.im}，负载 ${JSON.stringify(z)}`);
  assert.ok(mag(impedanceToGamma(result, z0)) < 1e-9);
  return solution;
}

test('L 匹配闭环：复数与纯实负载、多个频率和参考阻抗', () => {
  for (const fMHz of [100, 900, 2400]) {
    for (const z0 of [25, 50, 75]) {
      for (const z of [c(5), c(12.5, -40), c(24, 6.94), c(25), c(50), c(75), c(100), c(150, -500), c(500, 300), c(10, 500), c(0.1, -100)]) {
        verifyMatch(z, fMHz, z0);
      }
    }
  }
});

test('按电阻范围选取先串联/先并联的拓扑', () => {
  for (const z of [c(10, -10), c(25, 50), c(49, -100)]) {
    const solution = verifyMatch(z, 900);
    assert.equal(solution.elements.length, 2);
    assert.match(solution.elements[0].type, /^series/);
    assert.match(solution.elements[1].type, /^shunt/);
  }
  for (const z of [c(51, -10), c(100, 50), c(500, -100)]) {
    const solution = verifyMatch(z, 900);
    assert.equal(solution.elements.length, 2);
    assert.match(solution.elements[0].type, /^shunt/);
    assert.match(solution.elements[1].type, /^series/);
  }
});

test('已匹配无需元件，相等实部仅补偿虚部', () => {
  assert.deepEqual(suggestMatch(c(50), 900).elements, []);
  for (const imaginary of [-100, -1, 1, 100]) {
    const solution = verifyMatch(c(50, imaginary), 900);
    assert.equal(solution.elements.length, 1);
    assert.equal(solution.elements[0].type, imaginary > 0 ? 'seriesC' : 'seriesL');
  }
});

test('解析值的可复核结果和频率缩放', () => {
  // 25 Ω → 串联 +j25 Ω → 并联 +j0.02 S → 50 Ω。
  const low = verifyMatch(c(25), 100);
  assert.equal(low.elements[0].type, 'seriesL');
  assert.equal(low.elements[1].type, 'shuntC');
  assert.ok(Math.abs(low.elements[0].value - 25 / (2 * Math.PI * 100e6) * 1e9) < 1e-10);
  assert.ok(Math.abs(low.elements[1].value - 0.02 / (2 * Math.PI * 100e6) * 1e12) < 1e-10);
  const highFrequency = verifyMatch(c(25), 900);
  for (let index = 0; index < 2; index++) {
    assert.ok(Math.abs(low.elements[index].value / highFrequency.elements[index].value - 9) < 1e-10);
  }
  // 100 Ω → 并联 +j0.01 S → 50−j50 Ω → 串联 +j50 Ω → 50 Ω。
  const high = verifyMatch(c(100), 100);
  assert.equal(high.elements[0].type, 'shuntC');
  assert.equal(high.elements[1].type, 'seriesL');
  assert.ok(Math.abs(high.elements[0].value - 0.01 / (2 * Math.PI * 100e6) * 1e12) < 1e-10);
});

test('连续负载网格均能无残余匹配，输入不被修改', () => {
  for (let index = 0; index < 120; index++) {
    const r = 0.5 + ((index * 47) % 997);
    const x = ((index * 131) % 1201) - 600;
    const load = c(r, x);
    const before = { ...load };
    verifyMatch(load, 100 + index * 17, index % 2 ? 50 : 75);
    assert.deepEqual(load, before);
  }
});

test('拒绝不满足无损匹配条件的输入并提供中文错误', () => {
  for (const z of [c(), c(0, 50), c(-1), c(Infinity), c(50, Infinity), c(NaN)]) {
    assert.throws(() => suggestMatch(z, 900), /阻抗|电阻/);
  }
  for (const frequency of [0, -100, Infinity, NaN]) {
    assert.throws(() => suggestMatch(c(25), frequency), /频率/);
  }
  for (const z0 of [0, -50, Infinity, NaN]) {
    assert.throws(() => suggestMatch(c(25), 900, z0), /参考阻抗/);
  }
});
