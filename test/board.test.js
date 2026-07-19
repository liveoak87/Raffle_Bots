const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildWinnerEmbeds,
  buildWinnerAnnouncementEmbeds,
  buildMentionChunks,
  getExtensionIndexesForSlots
} = require('../src/board');

function embedTextLength(embed) {
  const data = embed.toJSON();
  return (data.title?.length || 0) +
    (data.description?.length || 0) +
    (data.footer?.text?.length || 0) +
    (data.fields || []).reduce((total, field) => total + field.name.length + field.value.length, 0);
}

test('large multi-winner draws stay within Discord embed limits', () => {
  const raffle = {
    id: 1,
    status: 'active',
    prize: 'Prize A\nPrize B',
    price: '$10',
    total_slots: 200,
    max_picks_per_user: 0,
    num_winners: 200,
    rules: '',
    created_by: '1'
  };
  const picks = Array.from({ length: 200 }, (_, index) => ({
    slot_number: index + 1,
    user_id: String(1000 + index),
    username: `User${index}`,
    paid: 1
  }));

  const boardEmbeds = buildWinnerEmbeds(raffle, picks, picks);
  const announcementEmbeds = buildWinnerAnnouncementEmbeds(picks);

  assert.equal(boardEmbeds.length, 1);
  assert.ok(embedTextLength(boardEmbeds[0]) <= 6000);
  for (const field of boardEmbeds[0].toJSON().fields) assert.ok(field.value.length <= 1024);
  assert.ok(announcementEmbeds.length > 1);
  for (const embed of announcementEmbeds) assert.ok(embedTextLength(embed) <= 4096);
});

test('winner mentions are unique and split below the message limit', () => {
  const ids = Array.from({ length: 200 }, (_, index) => String(100000000000000000n + BigInt(index)));
  ids.push(ids[0], ids[1]);
  const chunks = buildMentionChunks(ids);

  assert.deepEqual(chunks.flatMap(chunk => chunk.ids), ids.slice(0, 200));
  for (const chunk of chunks) {
    assert.ok(chunk.content.length <= 1900);
    assert.equal(new Set(chunk.ids).size, chunk.ids.length);
  }
});

test('only overflow messages containing changed slots are targeted', () => {
  assert.deepEqual(getExtensionIndexesForSlots([1, 24]), []);
  assert.deepEqual(getExtensionIndexesForSlots([25, 49, 50, 74, 75, 25]), [0, 1, 2]);
});
