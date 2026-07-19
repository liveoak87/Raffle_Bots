const test = require('node:test');
const assert = require('node:assert/strict');

const { createSingleFlightUpdateQueue } = require('../src/update-queue');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('updates for one raffle never overlap and new slots run afterward', async () => {
  const first = deferred();
  const calls = [];
  let running = 0;
  let maxRunning = 0;
  const enqueue = createSingleFlightUpdateQueue(async (raffle, slots) => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    calls.push({ raffle: raffle.id, slots });
    if (calls.length === 1) await first.promise;
    running--;
  }, 5);

  enqueue({ id: 7 }, [25]);
  await wait(15);
  enqueue({ id: 7 }, [50, 50]);
  await wait(15);
  assert.equal(calls.length, 1);

  first.resolve();
  await wait(20);
  assert.equal(maxRunning, 1);
  assert.deepEqual(calls, [
    { raffle: 7, slots: [25] },
    { raffle: 7, slots: [50] }
  ]);
});

test('bursts coalesce independently per raffle', async () => {
  const calls = [];
  const enqueue = createSingleFlightUpdateQueue(async (raffle, slots) => {
    calls.push({ raffle: raffle.id, slots });
  }, 5);

  enqueue({ id: 1 }, [25]);
  enqueue({ id: 1 }, [26, 25]);
  enqueue({ id: 2 }, [75]);
  await wait(20);

  calls.sort((a, b) => a.raffle - b.raffle);
  assert.deepEqual(calls, [
    { raffle: 1, slots: [25, 26] },
    { raffle: 2, slots: [75] }
  ]);
});

test('a main-board-only update queued during a running edit is not lost', async () => {
  const first = deferred();
  let calls = 0;
  const enqueue = createSingleFlightUpdateQueue(async () => {
    calls++;
    if (calls === 1) await first.promise;
  }, 5);

  enqueue({ id: 9 });
  await wait(15);
  enqueue({ id: 9 });
  first.resolve();
  await wait(20);

  assert.equal(calls, 2);
});
