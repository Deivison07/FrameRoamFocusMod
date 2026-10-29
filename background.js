importScripts('shared/settings.js');

const { load: loadSettings, computePlacement } = globalThis.FrameRoamSettings;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const getPlayers = async () => (await chrome.storage.session.get('players')).players ?? {};
const setPlayers = players => chrome.storage.session.set({ players });
const popupIds = async () => (await chrome.windows.getAll({ windowTypes: ['popup'] })).map(win => win.id);

// window.open() only gives the page a WindowProxy, so the player's chrome window is
// identified as the popup that did not exist before the page opened it.
const findNewPopup = async known => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const fresh = (await popupIds()).filter(id => !known.includes(id));
    if (fresh.length) return Math.max(...fresh);
    await delay(50);
  }
  return null;
};

const placementFor = async browserWindowId => {
  const [settings, displays, { lastBounds }, browser] = await Promise.all([
    loadSettings(),
    chrome.system.display.getInfo(),
    chrome.storage.local.get('lastBounds'),
    chrome.windows.get(browserWindowId).catch(() => null)
  ]);
  return { settings, ...computePlacement(settings, displays, browser, lastBounds) };
};

const handlers = {
  async FRAMEROAM_PREPARE(message, sender) {
    const [known, placement] = await Promise.all([
      popupIds(),
      placementFor(sender.tab.windowId).catch(() => null)
    ]);
    return { ok: true, known, bounds: placement?.bounds };
  },

  async FRAMEROAM_PLACE(message, sender) {
    const windowId = await findNewPopup(message.known ?? []);
    if (windowId === null) return { ok: false };
    await setPlayers({ ...await getPlayers(), [windowId]: sender.tab.id });

    const { settings, bounds } = await placementFor(sender.tab.windowId);
    await chrome.windows.update(windowId, bounds);
    if (!settings.fullscreen) return { ok: true, windowId, fullscreen: false };
    // Let the window manager finish the move so fullscreen lands on the target monitor.
    await delay(200);
    await chrome.windows.update(windowId, { state: 'fullscreen', focused: true });
    return { ok: true, windowId, fullscreen: true };
  },

  async FRAMEROAM_FULLSCREEN(message, sender) {
    if ((await getPlayers())[message.windowId] !== sender.tab.id) return { ok: false };
    const { state } = await chrome.windows.get(message.windowId);
    const fullscreen = state !== 'fullscreen';
    await chrome.windows.update(message.windowId, { state: fullscreen ? 'fullscreen' : 'normal', focused: true });
    return { ok: true, fullscreen };
  }
};

// Tabs that were already open when the extension was installed or reloaded do not get the
// manifest content scripts, and the copies injected before a reload stop working.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install' && reason !== 'update') return;
  for (const script of chrome.runtime.getManifest().content_scripts ?? []) {
    const tabs = await chrome.tabs.query({ url: script.matches });
    await Promise.all(tabs.map(tab => chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: Boolean(script.all_frames) },
      files: script.js
    }).catch(() => {})));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender.tab || !Object.hasOwn(handlers, message?.type)) return undefined;
  handlers[message.type](message, sender)
    .then(sendResponse, error => sendResponse({ ok: false, message: error.message }));
  return true;
});

const saveTimers = new Map();
chrome.windows.onBoundsChanged.addListener(async win => {
  if (!(win.id in await getPlayers())) return;
  // Entering or leaving fullscreen reports intermediate bounds and a drag fires many events,
  // so save once the window has settled, and only as a normal window.
  clearTimeout(saveTimers.get(win.id));
  saveTimers.set(win.id, setTimeout(async () => {
    saveTimers.delete(win.id);
    const current = await chrome.windows.get(win.id).catch(() => null);
    if (current?.state !== 'normal') return;
    await chrome.storage.local.set({
      lastBounds: { left: current.left, top: current.top, width: current.width, height: current.height }
    });
  }, 500));
});

chrome.windows.onRemoved.addListener(async windowId => {
  const players = await getPlayers();
  if (!(windowId in players)) return;
  delete players[windowId];
  await setPlayers(players);
}, { windowTypes: ['popup'] });
