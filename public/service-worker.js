const DATABASE = "safe-fable-opto-sync";
const VERSION = 1;
const QUEUE = "mutations";

function openQueue() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(QUEUE, { keyPath: "id" });
      store.createIndex("lane", "lane", { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, operation) {
  const database = await openQueue();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(QUEUE, mode);
      const request = operation(transaction.objectStore(QUEUE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

async function enqueue(message) {
  const item = {
    id: `${message.lane}:${message.recordId}:${crypto.randomUUID()}`,
    lane: message.lane,
    recordId: message.recordId,
    baseJson: message.baseJson,
    incomingJson: message.incomingJson,
    queuedAt: Date.now(),
  };
  await withStore("readwrite", (store) => store.add(item));

  if (self.registration.sync) {
    await self.registration.sync.register("opto-sync-drain");
  }
}

function pending() {
  return withStore("readonly", (store) => store.getAll());
}

function acknowledge(id) {
  return withStore("readwrite", (store) => store.delete(id));
}

async function publishResult(result) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    client.postMessage({ type: "opto-sync-merged", ...result });
  }
}

async function drainLane(items) {
  for (const item of items.sort((left, right) => left.queuedAt - right.queuedAt)) {
    const response = await fetch("/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(item),
    });

    if (!response.ok) {
      throw new Error(`OptoSync lane ${item.lane} failed with ${response.status}`);
    }

    const result = await response.json();
    await acknowledge(item.id);
    await publishResult(result);
  }
}

async function drain() {
  const items = await pending();
  const lanes = new Map();
  for (const item of items) {
    const lane = lanes.get(item.lane) ?? [];
    lane.push(item);
    lanes.set(item.lane, lane);
  }

  await Promise.all([...lanes.values()].map(drainLane));
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "enqueue") {
    event.waitUntil(enqueue(event.data).then(drain));
  } else if (event.data?.type === "drain") {
    event.waitUntil(drain());
  }
});

self.addEventListener("sync", (event) => {
  if (event.tag === "opto-sync-drain") {
    event.waitUntil(drain());
  }
});
