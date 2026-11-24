const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client, Events } = require('discord.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raffle-interactions-'));
process.env.DATABASE_PATH = path.join(dir, 'raffle.db');
const db = require('../src/database');
const dashboard = require('../src/dashboard/server');

function create(channel, slots = 50, locked = false) {
  return db.createRaffle('guild', channel, 'First\nSecond', '$5', slots, 'owner', 2, 'Custom rules', 2, locked);
}

const complete = create('complete', 50, true);
db.replaceRaffleMessages(complete, 'main', ['ext1', 'ext2']);
const partial = create('partial');
db.replaceRaffleMessages(partial, 'partial-main', ['partial-ext']);
const noMessages = create('empty');
const missing = create('missing', 2);
db.setRaffleMessage(missing, 'deleted');
const oldActive = create('existing', 10, true);
db.replaceRaffleMessages(oldActive, 'existing-board', []);
db.activateRaffle(oldActive);
db.pickSlot(oldActive, 1, 'old-user', 'Old nickname');
db.markPaid(oldActive, [1]);
const savedActive = db.getRaffleById(oldActive);
const savedPicks = db.getPicks(oldActive);
let client;
let dispatch;
test.before(() => {
  const login = test.mock.method(Client.prototype, 'login', function () { client = this; });
  require('../src/index');
  login.mock.restore();
  dispatch = client.listeners(Events.InteractionCreate)[0];
});
test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function interaction(kind, customId, options = {}) {
  return {
    customId, user: { id: 'owner', username: 'Owner' },
    isButton: () => kind === 'button', isChatInputCommand: () => kind === 'command',
    isStringSelectMenu: () => kind === 'slot', isUserSelectMenu: () => kind === 'user',
    isModalSubmit: () => kind === 'modal',
    reply(payload) { this.response = payload; }, update(payload) { this.response = payload; },
    editReply(payload) { this.response = payload; }, deferUpdate() { this.deferred = true; },
    ...options
  };
}
function command(sub, channelId, options = {}) {
  return interaction('command', null, { commandName: 'randomizer', options: { getSubcommand: () => sub }, channelId, ...options });
}
function active(channel, slots = 2) {
  const id = create(channel, slots);
  db.replaceRaffleMessages(id, 'board', slots > 24 ? ['ext'] : []);
  db.activateRaffle(id);
  return id;
}

test('startup verifies complete publications, preserves settings and leaves partial setups cancellable', async t => {
  t.mock.method(dashboard, 'start', () => {});
  client.user = { id: 'bot', tag: 'test' };
  const deleted = [];
  const fetched = [];
  const channel = { messages: {
    async fetch({ message, force }) {
      assert.equal(force, true);
      fetched.push(message);
      if (message === 'deleted') throw new Error('message no longer exists');
      return { author: { id: 'bot' } };
    },
    delete(id) { deleted.push(id); }
  }, send() {} };
  t.mock.method(client.channels, 'fetch', async () => channel);
  const before = db.getRaffleById(complete);
  client.emit(Events.ClientReady, client);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fetched, ['main', 'ext1', 'ext2', 'deleted']);
  assert.deepEqual(db.getActiveRaffle('complete'), { ...before, status: 'active' });
  assert.deepEqual(db.getRaffleById(oldActive), savedActive);
  assert.deepEqual(db.getPicks(oldActive), savedPicks);
  assert.equal(db.getRaffleById(missing).status, 'creating');
  const blocked = command('create', 'partial');
  await dispatch(blocked);
  assert.match(blocked.response.content, /randomizer cancel/);
  const denied = command('cancel', 'partial', { user: { id: 'other' } });
  await dispatch(denied);
  assert.match(denied.response.content, /Only the creator/);
  const cancel = command('cancel', 'partial');
  await dispatch(cancel);
  const confirmId = cancel.response.components[0].components[0].data.custom_id;
  await dispatch(interaction('button', confirmId));
  assert.equal(db.getCreatingOrActiveRaffle('partial'), undefined);
  assert.deepEqual(deleted, ['partial-main', 'partial-ext']);
  assert.equal(db.getRaffleById(partial).rules, 'Custom rules');
  const emptyCancel = command('cancel', 'empty');
  await dispatch(emptyCancel);
  const emptyId = emptyCancel.response.components[0].components[0].data.custom_id;
  await dispatch(interaction('button', emptyId));
  assert.equal(db.getRaffleById(noMessages).status, 'cancelled');
  assert.deepEqual(deleted, ['partial-main', 'partial-ext']);
  await dispatch(interaction('button', 'confirm_cancel_' + complete + '_setup'));
  assert.deepEqual(db.getActiveRaffle('complete'), { ...before, status: 'active' });
});

test('wizard checkpoints every posted message with the chosen settings before activation', async t => {
  const channelId = 'new-board';
  const values = { prize: 'First,Second', slots: '50', price: '$5', max_picks: '2', num_winners: '2' };
  const wizard = { channelId, guildId: 'guild', fields: { getTextInputValue: key => values[key] } };
  await dispatch(interaction('modal', 'randomizer_create_modal', wizard));
  const key = 'guild_new-board_owner';
  await dispatch(interaction('button', 'wizard_lock_' + key));
  const snapshots = [];
  t.mock.method(client.channels, 'fetch', async () => ({
    async send() {
      const raffle = db.getCreatingOrActiveRaffle(channelId);
      snapshots.push([raffle.status, raffle.message_id, db.getExtensionMessages(raffle.id), raffle.assign_only]);
      const attempt = command('cancel', channelId);
      await dispatch(attempt);
      assert.match(attempt.response.content, /being posted/);
      return { id: 'post-' + snapshots.length };
    }
  }));
  await dispatch(interaction('modal', 'randomizer_rules_modal_' + key, {
    deferReply() {}, fields: { getTextInputValue: () => 'Custom rules' }
  }));
  assert.deepEqual(snapshots, [
    ['creating', null, [], 1], ['creating', 'post-1', [], 1], ['creating', 'post-1', ['post-2'], 1]
  ]);
  const raffle = db.getActiveRaffle(channelId);
  assert.deepEqual(db.getExtensionMessages(raffle.id), ['post-2', 'post-3']);
  assert.deepEqual([raffle.prize, raffle.rules, raffle.price, raffle.max_picks_per_user, raffle.num_winners, raffle.assign_only],
    ['First\nSecond', 'Custom rules', '$5', 2, 2, 1]);
});

test('independent menus assign the displayed member once, using the supplied nickname', async t => {
  const id = active('assign');
  const lookup = t.mock.method(client.guilds, 'fetch', () => { throw new Error('unexpected lookup'); });
  const menus = [];
  for (const userId of ['alice', 'bob']) {
    const user = interaction('user', 'assign_user_' + id, {
      users: { first: () => ({ id: userId, username: userId }) },
      members: new Map([[userId, { nick: userId + ' nick' }]]), message: { id: userId + '-menu' }
    });
    await dispatch(user);
    menus.push(user.response.components[0].components[0].data.custom_id);
  }
  assert.equal(lookup.mock.callCount(), 0);
  const click = (customId, message, slot, admin = 'owner') => interaction('slot', customId, {
    user: { id: admin }, message: { id: message }, values: [String(slot)]
  });
  await dispatch(click(menus[0], 'bob-menu', 1));
  await dispatch(click(menus[0], 'alice-menu', 1, 'other'));
  assert.equal(db.getPicks(id).length, 0);
  await dispatch(click(menus[0], 'alice-menu', 1));
  await dispatch(click(menus[0], 'alice-menu', 2));
  await dispatch(click(menus[1], 'bob-menu', 2));
  assert.deepEqual(db.getPicks(id).map(p => [p.user_id, p.username]), [['alice', 'alice nick'], ['bob', 'bob nick']]);
  client.channels.cache.set('assign', { messages: { edit() {} } });
});

test('direct assignment acknowledges before a fallback lookup and keeps the username when the lookup fails', async t => {
  const id = active('direct');
  const events = [];
  t.mock.method(client.guilds, 'fetch', async () => { events.push('lookup'); throw new Error('offline'); });
  const select = interaction('user', 'assign_direct_' + id + '_1', {
    members: new Map(), users: { first: () => ({ id: 'recipient', username: 'Recipient' }) },
    deferUpdate() { this.deferred = true; events.push('ack'); },
    editReply() { events.push('edit'); }, deleteReply() {}
  });
  client.channels.cache.set('direct', { messages: { edit() {} } });
  await dispatch(select);
  assert.deepEqual(events, ['ack', 'lookup', 'edit']);
  assert.equal(db.getSlot(id, 1).username, 'Recipient');
});

test('button and multi-slot slash picks refresh the correct messages after response failure', async () => {
  const id = active('pick', 29);
  const edits = [];
  client.channels.cache.set('pick', { messages: { edit(message, payload) { edits.push([message, payload]); } } });
  const reject = async () => { throw new Error('simulated callback failure'); };
  await dispatch(interaction('button', 'pick_' + id + '_1', {
    message: { id: 'board' }, channelId: 'pick', deferUpdate: reject
  }));
  await dispatch(interaction('command', null, {
    commandName: 'pick', options: { getString: () => '25,26' }, user: { id: 'second', username: 'second' },
    channelId: 'pick', reply: reject
  }));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(db.getPicks(id).map(p => p.slot_number), [1, 25, 26]);
  assert.deepEqual(edits.map(([message]) => message).sort(), ['board', 'ext']);
  const disabled = edits.flatMap(([, payload]) => payload.components.flatMap(row => row.components))
    .filter(button => button.data.disabled).map(button => button.data.label);
  assert.deepEqual(disabled.sort(), ['1', '25', '26']);
});

for (const mode of ['auto', 'manual']) {
  test(mode + ' draw acknowledges before blocked board edits and waits before selecting winners', async () => {
    const slot = mode === 'manual' ? 25 : 1;
    const id = active(mode, Math.max(2, slot));
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const events = [];
    client.channels.cache.set(mode, {
      messages: {
        async edit(message) {
          if (message === 'ext') throw new Error('overflow message unavailable');
          events.push('edit');
          await pending;
        },
        delete() {}
      },
      send() { events.push('countdown'); return { edit() {} }; }
    });
    await dispatch(interaction('button', 'pick_' + id + '_' + slot, { channelId: mode, message: { id: slot === 1 ? 'board' : 'ext' } }));
    const draw = interaction('button', 'draw_mode_' + mode + '_' + id + '_early', {
      channelId: mode, update() { events.push('ack'); }
    });
    const running = dispatch(draw);
    await new Promise(resolve => setImmediate(resolve));
    try {
      assert.deepEqual(events, ['ack', 'edit']);
      assert.equal(db.getDrawSession(id).pool, null);
    } finally {
      release();
      await running;
    }
    assert.ok(events.includes('countdown'));
    if (mode === 'auto') assert.equal(db.getRaffleById(id).winner_slot, 1);
    else assert.equal(db.getDrawSession(id).drawnWinners[0].slot_number, slot);
  });
}
