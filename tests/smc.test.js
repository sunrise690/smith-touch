import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSMC } from '../src/smc.js';

const simple = `[DATAPOINTS]
NR=1
START=1
R=0,25
X=0,-10
F=0,2.4E9
[Z0]
Z0=50
`;

test('导入自制单负载工程与 SI 元件单位', () => {
  const result = parseSMC(`${simple}[ELEMENTS]
NR=6
TYP=0,IS
VAL=0,4.7e-9
TYP=1,IP
VAL=1,10e-9
TYP=2,CS
VAL=2,2e-12
TYP=3,CP
VAL=3,3e-12
TYP=4,RS
VAL=4,5
TYP=5,RP
VAL=5,100
`);
  assert.equal(result.frequencyMHz, 2400);
  assert.deepEqual(result.load, { re: 25, im: -10 });
  assert.deepEqual(result.elements.map(({ type }) => type), ['seriesL', 'shuntL', 'seriesC', 'shuntC', 'seriesR', 'shuntR']);
  const expected = [4.7, 10, 2, 3, 5, 100];
  result.elements.forEach((element, index) => assert.ok(Math.abs(element.value - expected[index]) < 1e-10));
  assert.deepEqual(result.warnings, []);
});

test('START 从1开始，保留多频负载并按频率排序', () => {
  const result = parseSMC(`[DATAPOINTS]
NR=3
START=2
R=0,50
X=0,0
F=0,3e9
R=1,100
X=1,0
F=1,1e9
R=2,25
X=2,0
F=2,2e9
[Z0]
Z0=50
`);
  assert.equal(result.frequencyMHz, 1000);
  assert.deepEqual(result.load, { re: 100, im: 0 });
  assert.deepEqual(result.loadData.points.map(({ frequencyMHz }) => frequencyMHz), [1000, 2000, 3000]);
  assert.equal(result.loadData.points[0].gamma.re, 1 / 3);
  assert.equal(result.loadData.points[2].gamma.re, 0);
});

test('线与支节 VAL 以波长为单位，映射电长度；ER 不重复乘入', () => {
  const result = parseSMC(`${simple}[ELEMENTS]
NR=3
TYP=0,LS
VAL=0,0.125
IMP=0,75
ER=0,4
TYP=1,LPS
VAL=1,0.25
IMP=1,100
TYP=2,LPO
VAL=2,0.1
IMP=2,50
`);
  assert.deepEqual(result.elements.map(({ type, value, z0, refMHz }) => ({ type, value, z0, refMHz })), [
    { type: 'line', value: 45, z0: 75, refMHz: 2400 },
    { type: 'shortStub', value: 90, z0: 100, refMHz: 2400 },
    { type: 'openStub', value: 36, z0: 50, refMHz: 2400 },
  ]);
  assert.ok(result.warnings.some((warning) => warning.includes('LPO')));
});

test('未支持元件和覆盖层必须给出明确警告', () => {
  const result = parseSMC(`${simple}[ELEMENTS]
NR=1
TYP=0,TRANSFORMER
VAL=0,2
[GAIN]
NR=1
[Q]
NR=1
[WIDEBAND]
WIDEBAND=TRUE
`);
  assert.equal(result.elements.length, 0);
  assert.ok(result.warnings.some((warning) => warning.includes('网络不完整')));
  assert.ok(result.warnings.some((warning) => warning.includes('增益圆') && warning.includes('Q 等值线')));
  assert.ok(result.warnings.some((warning) => warning.includes('重新扫频')));
});

test('拒绝损坏、越界和奇异数据', () => {
  assert.throws(() => parseSMC('hello'), /区段/);
  assert.throws(() => parseSMC(simple.replace('START=1', 'START=0')), /START/);
  assert.throws(() => parseSMC(simple.replace('START=1', 'START=2')), /START/);
  assert.throws(() => parseSMC(simple.replace('R=0,25', 'R=0,NaN')), /有限数值/);
  assert.throws(() => parseSMC(simple.replace('F=0,2.4E9', 'F=0,0')), /大于零/);
  assert.throws(() => parseSMC(simple.replace('Z0=50', 'Z0=-50')), /大于零/);
  assert.throws(() => parseSMC(simple.replace('X=0,-10', '')), /缺少/);
  assert.throws(() => parseSMC(`${simple}[ELEMENTS]\nNR=1\nTYP=0,CS\nVAL=0,0`), /无源/);
});
