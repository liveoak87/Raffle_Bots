// Fair, cryptographically-seeded randomness for draws.
// Math.random() is biased (and predictable); a `sort(() => Math.random() - 0.5)`
// shuffle is non-uniform. crypto.randomInt + Fisher–Yates gives every entrant an
// equal, unpredictable chance of winning. Extracted here so it can be unit-tested.
const { randomInt } = require('crypto');

function cryptoShuffle(array) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cryptoRandomIndex(length) {
  return randomInt(length);
}

module.exports = { cryptoShuffle, cryptoRandomIndex };
