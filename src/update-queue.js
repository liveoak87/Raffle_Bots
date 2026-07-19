function createSingleFlightUpdateQueue(worker, delayMs = 250, onError = () => {}) {
  const states = new Map();

  function schedule(state) {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => run(state), delayMs);
    state.timer.unref?.();
  }

  async function run(state) {
    state.timer = null;
    if (state.running) return;

    state.running = true;
    const slots = [...state.slots];
    state.slots.clear();
    state.queued = false;
    try {
      await worker(state.raffle, slots);
    } catch (err) {
      onError(err, state.raffle);
    } finally {
      state.running = false;
      if (state.queued) {
        schedule(state);
      } else if (!state.timer) {
        states.delete(state.raffle.id);
      }
    }
  }

  return function enqueue(raffle, slotNumbers = []) {
    let state = states.get(raffle.id);
    if (!state) {
      state = { raffle, slots: new Set(), timer: null, running: false, queued: false };
      states.set(raffle.id, state);
    } else {
      state.raffle = raffle;
    }

    for (const slot of slotNumbers) state.slots.add(slot);
    state.queued = true;
    if (!state.running) schedule(state);
  };
}

module.exports = { createSingleFlightUpdateQueue };
