/// <reference lib="webworker" />
//
// Broker SharedWorker. It does NOT own the DB and never spawns a worker (a SharedWorker can't —
// `Worker` is undefined there). It only relays MessagePorts between tabs: the leader tab
// registers a control channel, and every tab (leader included) requests a port to the leader's
// db worker, which the broker obtains from the leader and forwards. On a new leader (handoff),
// it tells all tabs to reconnect.

let leaderControl: MessagePort | null = null;
let hadLeader = false;
const tabs = new Set<MessagePort>();
const pending: { tab: MessagePort; id: number }[] = [];
let nextId = 1;

(self as unknown as SharedWorkerGlobalScope).onconnect = (event) => {
  const tab = event.ports[0];
  tabs.add(tab);

  tab.onmessage = (m: MessageEvent) => {
    const data = m.data;

    if (data?.type === 'leader' && data.control) {
      const isHandoff = hadLeader;
      hadLeader = true;
      leaderControl = data.control as MessagePort;
      leaderControl.onmessage = (lm: MessageEvent) => {
        if (lm.data?.type === 'minted') {
          const i = pending.findIndex((p) => p.id === lm.data.id);
          if (i >= 0) {
            const req = pending[i];
            pending.splice(i, 1);
            req.tab.postMessage({ type: 'worker-port', port: lm.data.port }, [lm.data.port]);
          }
        }
      };
      leaderControl.start();
      // A previous leader was replaced — tell every tab to reconnect to the new worker.
      if (isHandoff) for (const t of tabs) t.postMessage({ type: 'leader-changed' });
      // Fulfil anything queued before a leader existed.
      for (const p of pending) leaderControl.postMessage({ type: 'mint', id: p.id });
    } else if (data?.type === 'want') {
      const id = nextId++;
      pending.push({ tab, id });
      if (leaderControl) leaderControl.postMessage({ type: 'mint', id });
    }
  };

  tab.start();
};
