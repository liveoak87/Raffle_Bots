const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raffle-db-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'raffle.db');
const db = require('../src/database');

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('new raffles are not active until every message is published', () => {
  assert.equal(db.healthCheck(), true);
  const raffleId = db.createRaffle('guild', 'channel', 'Prize', '$5', 50, 'owner');
  assert.equal(db.getActiveRaffle('channel'), undefined);
  assert.equal(db.getCreatingOrActiveRaffle('channel').id, raffleId);

  assert.equal(db.replaceRaffleMessages(raffleId, 'main', ['ext-1', 'ext-2']), true);
  assert.equal(db.activateRaffle(raffleId), true);
  assert.equal(db.getActiveRaffle('channel').id, raffleId);
  assert.deepEqual(db.getExtensionMessages(raffleId), ['ext-1', 'ext-2']);
});

test('completed raffles reject picks and history mutations', () => {
  const raffle = db.getActiveRaffle('channel');
  assert.deepEqual(db.pickSlotWithLimit(raffle.id, 1, 'user-1', 'User One', 0), { success: true });
  assert.equal(db.togglePaid(raffle.id, 1), true);
  assert.equal(db.completeRaffle(raffle.id, 1, 'user-1', [
    { slot: 1, user_id: 'user-1', username: 'User One' }
  ]), true);

  assert.deepEqual(db.pickSlotWithLimit(raffle.id, 2, 'user-2', 'User Two', 0), { error: 'inactive' });
  assert.equal(db.pickSlot(raffle.id, 2, 'user-2', 'User Two'), false);
  assert.equal(db.togglePaid(raffle.id, 1), false);
  assert.equal(db.removePick(raffle.id, 1), false);
  assert.equal(db.completeRaffle(raffle.id, 1, 'user-1'), false);
  assert.equal(db.getPicks(raffle.id).length, 1);
});

function createActiveRaffle(channel, totalSlots) {
  const raffleId = db.createRaffle('guild', channel, 'Prize', '$5', totalSlots, 'owner');
  assert.equal(db.replaceRaffleMessages(raffleId, `main-${channel}`, []), true);
  assert.equal(db.activateRaffle(raffleId), true);
  return raffleId;
}

test('manual draw progress is persisted and blocks every raffle mutation', () => {
  const raffleId = createActiveRaffle('manual-channel', 3);
  assert.equal(db.pickSlot(raffleId, 1, 'user-1', 'One'), true);
  assert.equal(db.pickSlot(raffleId, 2, 'user-2', 'Two'), true);
  assert.equal(db.pickSlot(raffleId, 3, 'user-3', 'Three'), true);
  assert.equal(db.markAllPaid(raffleId), 3);

  const started = db.startDrawSession(raffleId, 'owner', 'manual', 'normal');
  assert.equal(started.success, true);
  assert.equal(db.hasDrawSession(raffleId), true);
  assert.deepEqual(db.pickSlotWithLimit(raffleId, 4, 'user-4', 'Four', 0), { error: 'drawing' });
  assert.equal(db.pickSlot(raffleId, 4, 'user-4', 'Four'), false);
  assert.equal(db.togglePaid(raffleId, 1), false);
  assert.equal(db.removePick(raffleId, 1), false);
  assert.equal(db.toggleAssignOnly(raffleId), false);
  assert.equal(db.replaceRaffleMessages(raffleId, 'replacement', []), false);
  assert.equal(db.cancelRaffle(raffleId), false);
  assert.equal(db.completeRaffle(raffleId, 1, 'user-1'), false);

  const pool = [started.picks[1], started.picks[0], started.picks[2]];
  const initialized = db.initializeDrawSession(raffleId, pool, 1);
  assert.equal(initialized.success, true);
  assert.deepEqual(initialized.session.drawnWinners.map(winner => winner.slot_number), [2]);
  assert.deepEqual(db.getDrawSession(raffleId).remainingPicks.map(pick => pick.slot_number), [1, 3]);

  const advanced = db.advanceDrawSession(raffleId);
  assert.equal(advanced.winner.slot_number, 1);
  assert.deepEqual(advanced.session.drawnWinners.map(winner => winner.slot_number), [2, 1]);

  const completed = db.completeDrawSession(raffleId);
  assert.equal(completed.success, true);
  assert.deepEqual(completed.winners.map(winner => winner.slot_number), [2, 1]);
  assert.equal(db.hasDrawSession(raffleId), false);
  assert.equal(db.getRaffleById(raffleId).status, 'completed');
  const publication = db.getPendingDrawPublications().find(item => item.raffle_id === raffleId);
  assert.deepEqual(publication.winners.map(winner => winner.slot_number), [2, 1]);
  assert.equal(db.markDrawPublished(raffleId), true);
  assert.equal(db.getPendingDrawPublications().some(item => item.raffle_id === raffleId), false);
});

test('an interrupted automatic draw resumes from its persisted winner order', () => {
  const raffleId = createActiveRaffle('auto-channel', 2);
  db.pickSlot(raffleId, 1, 'user-1', 'One');
  db.pickSlot(raffleId, 2, 'user-2', 'Two');
  db.markAllPaid(raffleId);

  const started = db.startDrawSession(raffleId, 'owner', 'auto', 'normal');
  assert.equal(started.success, true);
  assert.equal(db.getDrawSession(raffleId).pool, null);

  const pool = [started.picks[1], started.picks[0]];
  db.initializeDrawSession(raffleId, pool, 2);
  const databaseModule = require.resolve('../src/database');
  const recoveryScript = `
    process.env.DATABASE_PATH = ${JSON.stringify(process.env.DATABASE_PATH)};
    const db = require(${JSON.stringify(databaseModule)});
    const session = db.getDrawSession(${raffleId});
    process.stdout.write(JSON.stringify(session.drawnWinners.map(winner => winner.slot_number)));
    db.close();
  `;
  const restartedWinners = JSON.parse(execFileSync(process.execPath, ['-e', recoveryScript], { encoding: 'utf8' }));
  assert.deepEqual(restartedWinners, [2, 1]);

  const recovered = db.getDrawSession(raffleId);
  assert.deepEqual(recovered.drawnWinners.map(winner => winner.slot_number), [2, 1]);

  const completed = db.completeDrawSession(raffleId);
  assert.deepEqual(completed.winners.map(winner => winner.slot_number), [2, 1]);
  assert.equal(db.getRaffleById(raffleId).status, 'completed');

  const publicationRecoveryScript = `
    process.env.DATABASE_PATH = ${JSON.stringify(process.env.DATABASE_PATH)};
    const db = require(${JSON.stringify(databaseModule)});
    const publication = db.getPendingDrawPublications().find(item => item.raffle_id === ${raffleId});
    process.stdout.write(JSON.stringify(publication.winners.map(winner => winner.slot_number)));
    db.close();
  `;
  const restartedPublication = JSON.parse(execFileSync(process.execPath, ['-e', publicationRecoveryScript], { encoding: 'utf8' }));
  assert.deepEqual(restartedPublication, [2, 1]);
  assert.equal(db.markDrawPublished(raffleId), true);
});

test('early draw validation is explicit and transactional', () => {
  const raffleId = createActiveRaffle('early-channel', 3);
  db.pickSlot(raffleId, 1, 'user-1', 'One');

  const normal = db.startDrawSession(raffleId, 'owner', 'manual', 'normal');
  assert.deepEqual(normal, { error: 'open_slots', remaining: 2 });
  assert.equal(db.hasDrawSession(raffleId), false);

  const early = db.startDrawSession(raffleId, 'owner', 'manual', 'early');
  assert.equal(early.success, true);
  assert.equal(db.getDrawSession(raffleId).validation_mode, 'early');
});
