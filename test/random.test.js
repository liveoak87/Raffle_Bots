const { test } = require('node:test');
const assert = require('node:assert');
const { cryptoShuffle, cryptoRandomIndex } = require('../src/random');

test('cryptoShuffle returns a permutation (no loss, no duplication)', () => {
  const input = Array.from({ length: 50 }, (_, i) => i + 1);
  const out = cryptoShuffle(input);
  assert.strictEqual(out.length, input.length);
  assert.deepStrictEqual([...out].sort((a, b) => a - b), input);
});

test('cryptoShuffle does not mutate the input array', () => {
  const input = [1, 2, 3, 4, 5];
  const copy = [...input];
  cryptoShuffle(input);
  assert.deepStrictEqual(input, copy);
});

test('cryptoShuffle handles empty and single-element arrays', () => {
  assert.deepStrictEqual(cryptoShuffle([]), []);
  assert.deepStrictEqual(cryptoShuffle([42]), [42]);
});

test('cryptoRandomIndex stays within [0, length)', () => {
  for (let len = 1; len <= 20; len++) {
    for (let i = 0; i < 200; i++) {
      const idx = cryptoRandomIndex(len);
      assert.ok(idx >= 0 && idx < len, `idx ${idx} out of range for len ${len}`);
    }
  }
});

test('cryptoShuffle is statistically fair (each slot wins ~uniformly)', () => {
  // Draw the first element many times from a 6-element pool; every element
  // should win within a generous tolerance of the uniform expectation.
  const slots = [1, 2, 3, 4, 5, 6];
  const N = 60000;
  const counts = {};
  for (let i = 0; i < N; i++) {
    const winner = cryptoShuffle(slots)[0];
    counts[winner] = (counts[winner] || 0) + 1;
  }
  const expected = N / slots.length;
  for (const s of slots) {
    const dev = Math.abs(counts[s] - expected) / expected;
    assert.ok(dev < 0.1, `slot ${s} deviated ${(dev * 100).toFixed(1)}% from uniform (count ${counts[s]})`);
  }
});
