const { test, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Point the DB module at a throwaway file BEFORE requiring it.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raffle-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
const db = require('../src/database');

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('createRaffle + getActiveRaffle round-trips', () => {
  const id = db.createRaffle('g1', 'c1', 'Prize', '$5', 25, 'owner1', 0, null, 1);
  const r = db.getActiveRaffle('c1');
  assert.strictEqual(r.id, id);
  assert.strictEqual(r.total_slots, 25);
  assert.strictEqual(r.status, 'active');
});

test('pickSlot enforces the unique(raffle, slot) constraint', () => {
  const id = db.createRaffle('g1', 'c-pick', 'P', null, 10, 'o', 0, null, 1);
  assert.strictEqual(db.pickSlot(id, 5, 'userA', 'A'), true);
  assert.strictEqual(db.pickSlot(id, 5, 'userB', 'B'), false, 'second claim of same slot must fail');
  const slot = db.getSlot(id, 5);
  assert.strictEqual(slot.user_id, 'userA', 'first claimant keeps the slot');
});

test('pickSlotWithLimit enforces max picks per user', () => {
  const id = db.createRaffle('g1', 'c-limit', 'P', null, 10, 'o', 2, null, 1);
  assert.strictEqual(db.pickSlotWithLimit(id, 1, 'u', 'U', 2).success, true);
  assert.strictEqual(db.pickSlotWithLimit(id, 2, 'u', 'U', 2).success, true);
  assert.strictEqual(db.pickSlotWithLimit(id, 3, 'u', 'U', 2).error, 'limit_reached');
  assert.strictEqual(db.getUserPickCount(id, 'u'), 2);
});

test('pickSlotWithLimit reports taken slots distinctly from limit', () => {
  const id = db.createRaffle('g1', 'c-taken', 'P', null, 10, 'o', 0, null, 1);
  db.pickSlot(id, 7, 'first', 'First');
  assert.strictEqual(db.pickSlotWithLimit(id, 7, 'second', 'Second', 0).error, 'taken');
});

test('markPaid / togglePaid / markAll toggle donation state', () => {
  const id = db.createRaffle('g1', 'c-paid', 'P', null, 10, 'o', 0, null, 1);
  db.pickSlot(id, 1, 'u1', 'U1');
  db.pickSlot(id, 2, 'u2', 'U2');

  const res = db.markPaid(id, [1, 99]);
  assert.strictEqual(res.find(r => r.slot === 1).updated, true);
  assert.strictEqual(res.find(r => r.slot === 99).updated, false, 'unclaimed slot reports not updated');
  assert.strictEqual(db.getSlot(id, 1).paid, 1);

  db.togglePaid(id, 1);
  assert.strictEqual(db.getSlot(id, 1).paid, 0);

  db.markAllPaid(id);
  assert.ok(db.getPicks(id).every(p => p.paid === 1));
  db.markAllUnpaid(id);
  assert.ok(db.getPicks(id).every(p => p.paid === 0));
});

test('removePick frees the slot', () => {
  const id = db.createRaffle('g1', 'c-remove', 'P', null, 10, 'o', 0, null, 1);
  db.pickSlot(id, 3, 'u', 'U');
  assert.strictEqual(db.removePick(id, 3), true);
  assert.strictEqual(db.getSlot(id, 3), undefined);
  assert.strictEqual(db.pickSlot(id, 3, 'other', 'Other'), true, 'slot reusable after removal');
});

test('completeRaffle records winners and flips status', () => {
  const id = db.createRaffle('g1', 'c-done', 'P', null, 5, 'o', 0, null, 2);
  db.pickSlot(id, 1, 'u1', 'U1');
  db.pickSlot(id, 2, 'u2', 'U2');
  db.completeRaffle(id, 1, 'u1', [{ slot: 1, user_id: 'u1', username: 'U1' }, { slot: 2, user_id: 'u2', username: 'U2' }]);
  const r = db.getRaffleById(id);
  assert.strictEqual(r.status, 'completed');
  assert.strictEqual(r.winner_slot, 1);
  assert.strictEqual(JSON.parse(r.winners_json).length, 2);
  assert.strictEqual(db.getActiveRaffle('c-done'), undefined, 'completed raffle no longer active');
});
