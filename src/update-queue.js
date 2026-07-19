function createSingleFlightUpdateQueue(worker, delayMs = 250, onError = () => {}) {
  const states = new Map();

  function schedule(state) {
    if (state.timer) return;
    state.timer = setTimeout(() => run(state), delayMs);
    state.timer.unref?.();
  }

  async function run(state) {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.running) return state.currentRun;

    state.running = true;
    const slots = [...state.slots];
    state.slots.clear();
    state.queued = false;
    state.currentRun = (async () => {
      try {
        await worker(state.raffle, slots);
      } catch (err) {
        onError(err, state.raffle);
      } finally {
        state.running = false;
        state.currentRun = null;
        if (state.queued) {
          schedule(state);
        } else if (!state.timer) {
          states.delete(state.raffle.id);
        }
      }
    })();
    return state.currentRun;
  }

  async function flushState(state) {
    while (states.get(state.raffle.id) === state) {
      if (state.running) {
        await state.currentRun;
      } else if (state.queued || state.timer || state.slots.size > 0) {
        await run(state);
      } else {
        states.delete(state.raffle.id);
      }
    }
  }

  function enqueue(raffle, slotNumbers = []) {
    let state = states.get(raffle.id);
    if (!state) {
      state = { raffle, slots: new Set(), timer: null, running: false, currentRun: null, queued: false };
      states.set(raffle.id, state);
    } else {
      state.raffle = raffle;
    }

    for (const slot of slotNumbers) state.slots.add(slot);
    state.queued = true;
    if (!state.running) schedule(state);
  }

  enqueue.flush = async function flush(raffleId = null) {
    do {
      const selected = [...states.values()].filter(state => raffleId === null || state.raffle.id === raffleId);
      if (selected.length === 0) return;
      await Promise.all(selected.map(flushState));
    } while (raffleId === null && states.size > 0);
  };

  return enqueue;
}

module.exports = { createSingleFlightUpdateQueue };
