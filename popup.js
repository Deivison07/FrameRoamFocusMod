const status = document.querySelector('#status');
const openButton = document.querySelector('#open');
const closeButton = document.querySelector('#close');
const { findBestVideo } = globalThis.VideoControllerShared;
const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions) || key;
const activeTab = chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab);
let target;

document.documentElement.lang = t('@@ui_locale').replace('_', '-');
document.documentElement.dir = t('@@bidi_dir');
document.title = t('extensionName');
document.querySelectorAll('[data-i18n]').forEach(element => {
  element.textContent = t(element.dataset.i18n);
});
document.querySelectorAll('[data-i18n-aria-label]').forEach(element => {
  element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel));
});
document.querySelectorAll('[data-i18n-title]').forEach(element => {
  element.title = t(element.dataset.i18nTitle);
});
document.querySelector('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

function setStatus(message, state = 'loading') {
  status.textContent = message;
  document.body.dataset.state = state;
}

async function locateVideo() {
  try {
    const tab = await activeTab;
    if (!tab?.id) throw new Error(t('errorNoActiveTab'));
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: findBestVideo
    });
    const found = results.filter(item => item.result).sort((a, b) =>
      Number(b.result.playing) - Number(a.result.playing)
      || Number(b.result.ready) - Number(a.result.ready)
      || b.result.area - a.result.area)[0];
    if (!found) throw new Error(t('errorNoVideo'));

    target = { tabId: tab.id, frameId: found.frameId, videoIndex: found.result.index };
    setStatus(t(found.result.playing ? 'statusPlayingFound' : 'statusVideoFound'), 'ready');
    openButton.disabled = false;
  } catch (error) {
    const protectedPage = /Cannot access|chrome:\/\/|extensions gallery/i.test(error.message);
    setStatus(protectedPage ? t('errorRestricted') : error.message, 'error');
  }
}

openButton.addEventListener('click', async () => {
  if (!target) return;
  openButton.disabled = true;
  setStatus(t('statusOpening'));

  try {
    await chrome.scripting.executeScript({
      target: { tabId: target.tabId, frameIds: [target.frameId] },
      files: ['shared/settings.js', 'player.js']
    });
    const result = await chrome.tabs.sendMessage(
      target.tabId,
      { type: 'VIDEO_CONTROLLER_OPEN', videoIndex: target.videoIndex },
      { frameId: target.frameId }
    );
    if (!result?.ok) throw new Error(result?.message || t('errorOpenFailed'));

    if (result.pending) {
      setStatus(t('statusUserGesture'), 'action');
      setTimeout(() => window.close(), 1200);
    } else if (result.mode === 'native-pip') {
      setStatus(t('statusNativePip'), 'ready');
      setTimeout(() => window.close(), 1200);
    } else {
      window.close();
    }
  } catch (error) {
    setStatus(error.message, 'error');
    openButton.disabled = false;
  }
});

// The service worker records each player window it placed with the tab that opened it.
const tabPlayerWindowIds = async () => {
  const [tab, { players = {} }] = await Promise.all([activeTab, chrome.storage.session.get('players')]);
  return Object.entries(players)
    .filter(([, tabId]) => tabId === tab?.id)
    .map(([windowId]) => Number(windowId));
};

closeButton.addEventListener('click', async () => {
  closeButton.disabled = true;
  await Promise.all((await tabPlayerWindowIds()).map(id => chrome.windows.remove(id).catch(() => {})));
  window.close();
});

locateVideo();
tabPlayerWindowIds().then(ids => { closeButton.hidden = !ids.length; });
