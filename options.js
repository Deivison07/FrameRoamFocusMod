const { load, save, computePlacement } = globalThis.FrameRoamSettings;
const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions) || key;
const form = document.querySelector('#settings');
const map = document.querySelector('#map');
const status = document.querySelector('#saved');
let settings;
let displays = [];
let lastBounds;
let browserBounds;
let saveTimer;
let statusTimer;

document.documentElement.lang = t('@@ui_locale').replace('_', '-');
document.documentElement.dir = t('@@bidi_dir');
document.title = `${t('optionsTitle')} · ${t('extensionName')}`;
document.querySelectorAll('[data-i18n]').forEach(element => {
  element.textContent = t(element.dataset.i18n);
});

const displayNumber = display => displays.indexOf(display) + 1;
const displayLabel = display => {
  const { width, height } = display.bounds;
  const details = [display.name, `${width}×${height}`, display.isPrimary && t('displayPrimary')].filter(Boolean);
  return `${t('optionsMonitor')} ${displayNumber(display)} — ${details.join(' · ')}`;
};

function fillForm() {
  for (const element of form.elements) {
    if (!(element.name in settings)) continue;
    if (element.type === 'checkbox') element.checked = settings[element.name];
    else element.value = settings[element.name];
  }
}

function readForm() {
  const next = { ...settings };
  for (const element of form.elements) {
    if (!(element.name in settings)) continue;
    next[element.name] = element.type === 'checkbox' ? element.checked
      : element.type === 'number' ? Number(element.value)
        : element.value;
  }
  return next;
}

function renderDisplays() {
  const options = [
    new Option(t('displayOther'), 'other'),
    new Option(t('displaySame'), 'same'),
    ...displays.map(display => new Option(displayLabel(display), display.id))
  ];
  // Keep a chosen monitor that is disconnected right now instead of silently dropping it.
  if (!options.some(option => option.value === settings.display)) {
    options.push(new Option(t('displayMissing'), settings.display));
  }
  form.elements.display.replaceChildren(...options);
  form.elements.display.value = settings.display;
}

function renderMap(placement) {
  const left = Math.min(...displays.map(({ bounds }) => bounds.left));
  const top = Math.min(...displays.map(({ bounds }) => bounds.top));
  const width = Math.max(...displays.map(({ bounds }) => bounds.left + bounds.width)) - left;
  const height = Math.max(...displays.map(({ bounds }) => bounds.top + bounds.height)) - top;
  const scale = Math.min(map.clientWidth / width, 180 / height);
  const offset = (map.clientWidth - width * scale) / 2;
  const box = (rect, className, label) => {
    const element = document.createElement('div');
    element.className = className;
    element.style.left = `${offset + (rect.left - left) * scale}px`;
    element.style.top = `${(rect.top - top) * scale}px`;
    element.style.width = `${rect.width * scale}px`;
    element.style.height = `${rect.height * scale}px`;
    if (label) element.textContent = label;
    return element;
  };
  map.style.height = `${height * scale}px`;
  map.replaceChildren(
    ...displays.map(display => box(
      display.bounds,
      display === placement.display ? 'screen target' : 'screen',
      String(displayNumber(display))
    )),
    box(settings.fullscreen ? placement.display.bounds : placement.bounds, 'player-window')
  );
}

function renderSavedPosition(placement) {
  document.querySelector('#remember-info').hidden = settings.position !== 'remember';
  document.querySelector('#forget').hidden = !lastBounds;
  const text = document.querySelector('#saved-position');
  if (!lastBounds) {
    text.textContent = t('optionsNoSavedPosition');
    return;
  }
  const where = placement.remembered ? ` · ${t('optionsMonitor')} ${displayNumber(placement.display)}` : '';
  text.textContent = `${t('optionsSavedPosition')}: ${lastBounds.width}×${lastBounds.height} (x ${lastBounds.left}, y ${lastBounds.top})${where}`;
}

function render() {
  if (!settings) return;
  document.querySelector('#custom-fields').hidden = settings.position !== 'custom';
  if (!displays.length) return;
  const placement = computePlacement(settings, displays, browserBounds, lastBounds);
  renderSavedPosition(placement);
  renderMap(placement);
}

async function loadDisplays() {
  displays = (await chrome.system.display.getInfo())
    .sort((a, b) => a.bounds.left - b.bounds.left || a.bounds.top - b.bounds.top);
  renderDisplays();
  render();
}

form.addEventListener('submit', event => event.preventDefault());
form.addEventListener('input', () => {
  settings = readForm();
  render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await save(settings);
    status.textContent = t('optionsSaved');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { status.textContent = ''; }, 1500);
  }, 250);
});
document.querySelector('#forget').addEventListener('click', () => chrome.storage.local.remove('lastBounds'));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.lastBounds) return;
  lastBounds = changes.lastBounds.newValue;
  render();
});
chrome.system.display.onDisplayChanged.addListener(loadDisplays);
window.addEventListener('resize', render);

(async () => {
  const [loaded, stored, current] = await Promise.all([
    load(),
    chrome.storage.local.get('lastBounds'),
    chrome.windows.getCurrent()
  ]);
  settings = loaded;
  lastBounds = stored.lastBounds;
  browserBounds = current;
  fillForm();
  await loadDisplays();
})();
