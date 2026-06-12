const { test } = require('node:test');
const assert = require('node:assert');
const { buildBoardEmbed, buildComponents, buildExtensionComponents } = require('../src/board');

function fakeRaffle(overrides = {}) {
  return {
    id: 1, prize: 'Test Prize', price: '$10', total_slots: 25,
    max_picks_per_user: 0, num_winners: 1, rules: null, status: 'active',
    assign_only: 0, ...overrides
  };
}

test('200-slot embed stays within Discord limits (worst case)', () => {
  const raffle = fakeRaffle({
    total_slots: 200, num_winners: 10, max_picks_per_user: 5,
    prize: 'Mega Bundle Giveaway Extravaganza',
    rules: 'Must be 18+, one per household, US only, no refunds'
  });
  const picks = [];
  for (let i = 1; i <= 200; i++) {
    picks.push({ slot_number: i, user_id: '1234567890' + i, username: 'SuperLongUsername' + i, paid: i % 2 });
  }
  const json = buildBoardEmbed(raffle, picks).toJSON();
  let total = (json.title || '').length + (json.description || '').length;
  let maxField = 0;
  for (const f of (json.fields || [])) {
    total += (f.name || '').length + (f.value || '').length;
    maxField = Math.max(maxField, (f.value || '').length);
  }
  assert.ok((json.fields || []).length <= 25, 'field count within 25');
  assert.ok(maxField <= 1024, `largest field ${maxField} within 1024`);
  assert.ok(total <= 6000, `total embed chars ${total} within 6000`);
});

test('main board never exceeds 5 action rows / 25 components', () => {
  for (const slots of [5, 20, 21, 24, 25, 100, 200]) {
    const rows = buildComponents(fakeRaffle({ total_slots: slots }), []);
    assert.ok(rows.length <= 5, `slots=${slots}: ${rows.length} rows (max 5)`);
    for (const row of rows) {
      assert.ok(row.components.length <= 5, `slots=${slots}: a row had >5 components`);
    }
  }
});

test('each extension message has at most 5 rows of 5 buttons', () => {
  const sets = buildExtensionComponents(fakeRaffle({ total_slots: 200 }), []);
  for (const msg of sets) {
    assert.ok(msg.length <= 5, 'extension message within 5 rows');
    for (const row of msg) assert.ok(row.components.length <= 5, 'row within 5 buttons');
  }
});

test('completed/cancelled raffles render no interactive components', () => {
  assert.deepStrictEqual(buildComponents(fakeRaffle({ status: 'completed' }), []), []);
  assert.deepStrictEqual(buildComponents(fakeRaffle({ status: 'cancelled' }), []), []);
  assert.deepStrictEqual(buildExtensionComponents(fakeRaffle({ status: 'completed', total_slots: 100 }), []), []);
});
