(() => {
if (globalThis.FrameRoamSettings) return;

const DEFAULTS = Object.freeze({
  display: 'other',
  position: 'remember',
  width: 1280,
  height: 720,
  x: 0,
  y: 0,
  fullscreen: false,
  closeOnEnd: true,
  followVideo: true,
  youtubeButton: true
});

const load = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get('settings')).settings });
const save = settings => chrome.storage.local.set({ settings });
const subscribe = callback => {
  load().then(callback);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) callback({ ...DEFAULTS, ...changes.settings.newValue });
  });
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const centerOf = rect => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
const contains = (rect, point) => point.x >= rect.left && point.x < rect.left + rect.width
  && point.y >= rect.top && point.y < rect.top + rect.height;
const displayAt = (displays, rect) => rect ? displays.find(display => contains(display.bounds, centerOf(rect))) : undefined;

const pickDisplay = (settings, displays, browserBounds) => {
  const current = displayAt(displays, browserBounds) ?? displays.find(display => display.isPrimary) ?? displays[0];
  if (settings.display === 'same') return current;
  return displays.find(display => display.id === settings.display)
    ?? displays.find(display => display !== current)
    ?? current;
};

// Bounds use Chrome's screen coordinates, shared by chrome.windows and chrome.system.display.
const computePlacement = (settings, displays, browserBounds, lastBounds) => {
  if (settings.position === 'remember' && lastBounds) {
    const display = displayAt(displays, lastBounds);
    if (display) return { display, bounds: { ...lastBounds }, remembered: true };
  }
  const display = pickDisplay(settings, displays, browserBounds);
  const area = display.workArea;
  const width = Math.round(clamp(settings.width, 320, area.width));
  const height = Math.round(clamp(settings.height, 200, area.height));
  const freeX = area.width - width;
  const freeY = area.height - height;
  const offsets = {
    'top-left': [0, 0],
    'top-right': [freeX, 0],
    'bottom-left': [0, freeY],
    'bottom-right': [freeX, freeY],
    custom: [clamp(settings.x, 0, freeX), clamp(settings.y, 0, freeY)]
  };
  const [dx, dy] = offsets[settings.position] ?? [freeX / 2, freeY / 2];
  return {
    display,
    bounds: { left: Math.round(area.left + dx), top: Math.round(area.top + dy), width, height },
    remembered: false
  };
};

globalThis.FrameRoamSettings = Object.freeze({ DEFAULTS, load, save, subscribe, computePlacement });
})();
