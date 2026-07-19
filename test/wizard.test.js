const test = require('node:test');
const assert = require('node:assert/strict');

const { parseModalValues } = require('../src/wizard');

function interactionWith(values) {
  return {
    fields: {
      getTextInputValue(name) {
        return values[name] ?? '';
      }
    }
  };
}

test('raffle wizard accepts strict integer settings and multiple prizes', () => {
  const result = parseModalValues(interactionWith({
    prize: 'First Prize, Second Prize',
    slots: '200',
    price: '$5',
    max_picks: '10',
    num_winners: '125'
  }));

  assert.deepEqual(result, {
    prize: 'First Prize\nSecond Prize',
    totalSlots: 200,
    price: '$5',
    maxPicksPerUser: 10,
    numWinners: 125
  });
});

test('raffle wizard rejects partial numbers and impossible limits', () => {
  const base = { prize: 'Prize', slots: '25', max_picks: '0', num_winners: '1' };

  assert.match(parseModalValues(interactionWith({ ...base, slots: '25abc' })).error, /spots/);
  assert.match(parseModalValues(interactionWith({ ...base, max_picks: '2.5' })).error, /Max picks/);
  assert.match(parseModalValues(interactionWith({ ...base, max_picks: '26' })).error, /Max picks/);
  assert.match(parseModalValues(interactionWith({ ...base, num_winners: '1e2' })).error, /winners/);
  assert.match(parseModalValues(interactionWith({ ...base, prize: '   ' })).error, /Prize/);
});
