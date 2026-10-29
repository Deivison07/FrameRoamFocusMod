(() => {
  if (globalThis.__frameRoamYoutubeInstalled) return;
  globalThis.__frameRoamYoutubeInstalled = true;
  const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions) || key;
  const { FrameRoamFocus: player, FrameRoamSettings } = globalThis;
  const buttonClass = 'frameroam-ytp-button';
  const svgNs = 'http://www.w3.org/2000/svg';
  const ownButtons = new WeakSet();
  const alive = () => Boolean(chrome.runtime?.id);
  let enabled = false;
  let scheduled = false;

  // Copies the format of a button YouTube always renders, so its CSS sizes and pads our icon
  // the same way: 24px icons in the current player, 36-unit icons filling the button in the
  // older one. Hidden buttons such as "Expand" still use the old format and must not be used.
  const createIcon = controls => {
    const reference = controls.querySelector('.ytp-settings-button svg, .ytp-size-button svg, .ytp-fullscreen-button svg');
    const compact = (reference?.getAttribute('viewBox') ?? '0 0 24 24') === '0 0 24 24';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', compact ? '0 0 24 24' : '-6 -6 36 36');
    svg.setAttribute('width', compact ? reference?.getAttribute('width') ?? '24' : '100%');
    svg.setAttribute('height', compact ? reference?.getAttribute('height') ?? '24' : '100%');
    svg.setAttribute('aria-hidden', 'true');
    const stroke = { fill: 'none', stroke: '#fff', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    const shapes = [
      ['rect', { class: 'frameroam-screen', x: '2', y: '4', width: '20', height: '13', rx: '2' }],
      ['path', { d: 'M8 21h8M12 17v4' }],
      ['path', { d: 'M8.5 13.5l6-5M11 8.5h3.5V12' }]
    ];
    for (const [tag, attributes] of shapes) {
      const shape = document.createElementNS(svgNs, tag);
      Object.entries({ ...stroke, ...attributes }).forEach(([name, value]) => shape.setAttribute(name, value));
      svg.append(shape);
    }
    return svg;
  };

  const syncButton = button => {
    const open = player.isOpen();
    const label = t(open ? 'youtubeButtonClose' : 'youtubeButtonOpen');
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(open));
    button.querySelector('.frameroam-screen')?.setAttribute('fill', open ? '#7778ff' : 'none');
  };

  const createButton = (videoPlayer, controls) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ytp-button ${buttonClass}`;
    button.append(createIcon(controls));
    ownButtons.add(button);
    button.addEventListener('click', async event => {
      event.stopPropagation();
      if (!alive()) {
        button.remove();
        return;
      }
      if (player.isOpen()) {
        player.close();
        return;
      }
      const video = videoPlayer.querySelector('video.html5-main-video') ?? videoPlayer.querySelector('video');
      if (!video) return;
      const result = await player.open(video);
      if (!result.ok) button.title = result.message;
    });
    syncButton(button);
    return button;
  };

  const addButtons = () => {
    scheduled = false;
    // Reloading the extension orphans this copy of the script: its button could no longer open
    // anything, so it steps aside for the copy the service worker injects.
    if (!alive()) {
      observer.disconnect();
      document.querySelectorAll(`.${buttonClass}`).forEach(button => {
        if (ownButtons.has(button)) button.remove();
      });
      return;
    }
    if (!enabled) return;
    document.querySelectorAll('.html5-video-player').forEach(videoPlayer => {
      const controls = videoPlayer.querySelector('.ytp-right-controls');
      if (!controls) return;
      const existing = controls.querySelector(`.${buttonClass}`);
      if (existing && ownButtons.has(existing)) return;
      existing?.remove();
      controls.prepend(createButton(videoPlayer, controls));
    });
  };

  // YouTube rebuilds its player while navigating between videos, so keep re-adding the button.
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(addButtons, 300);
  });

  FrameRoamSettings.subscribe(next => {
    enabled = next.youtubeButton;
    if (enabled) {
      observer.observe(document.documentElement, { childList: true, subtree: true });
      addButtons();
    } else {
      observer.disconnect();
      document.querySelectorAll(`.${buttonClass}`).forEach(button => button.remove());
    }
  });
  player.onChange(() => document.querySelectorAll(`.${buttonClass}`).forEach(syncButton));
})();
