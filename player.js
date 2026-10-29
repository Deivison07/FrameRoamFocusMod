(() => {
  if (globalThis.__videoControllerInstalled) return;
  globalThis.__videoControllerInstalled = true;
  const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions) || key;
  const endedGraceMs = 1500;

  let playerState = null;
  let settings = globalThis.FrameRoamSettings.DEFAULTS;
  globalThis.FrameRoamSettings.subscribe(next => { settings = next; });
  const subscribers = new Set();
  const notify = () => subscribers.forEach(callback => callback(Boolean(playerState)));

  const chooseVideo = index => {
    const videos = [...document.querySelectorAll('video')];
    return videos[index] ?? videos.find(video => !video.paused && !video.ended) ?? videos[0];
  };

  const stopStream = stream => stream?.getTracks().forEach(track => track.stop());
  const isYoutubeAd = video => Boolean(video.closest('.html5-video-player')?.classList.contains('ad-showing'));

  const openNativePip = async video => {
    if (!document.pictureInPictureEnabled || video.disablePictureInPicture) {
      throw new DOMException(t('errorProtectedPipUnavailable'), 'NotSupportedError');
    }
    if (document.pictureInPictureElement !== video) await video.requestPictureInPicture();
    return { ok: true, mode: 'native-pip' };
  };

  const installLaunchButton = target => {
    document.querySelector('#video-controller-launch')?.remove();
    const host = document.createElement('div');
    host.id = 'video-controller-launch';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:18px;left:50%;transform:translateX(-50%);';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `button{display:flex;align-items:center;gap:10px;padding:13px 20px;border:1px solid #ffffff35;border-radius:12px;background:#5b5cf0;color:white;box-shadow:0 12px 36px #0008;font:700 14px system-ui;cursor:pointer}button:hover{background:#6c6df5}button:focus-visible{outline:3px solid #b9c8ff;outline-offset:3px}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `▶  ${t('openPlayer')}`;
    shadow.append(style, button);
    button.addEventListener('click', async () => {
      host.remove();
      try {
        const result = await openPlayer(target);
        if (!result.ok) throw new Error(result.message);
      } catch (error) {
        button.textContent = `${t('retry')}: ${error.message}`;
        document.documentElement.append(host);
      }
    });
    document.documentElement.append(host);
    return { ok: true, pending: true };
  };

  const closePlayer = () => {
    const state = playerState;
    if (!state) return;
    state.cleanup();
    if (!state.window.closed) state.window.close();
  };

  // Shows another video in the player window that is already open. Reusing the window keeps
  // its monitor, position and fullscreen state, and a window.open() that is not triggered by
  // a click would be stopped by the popup blocker.
  const replaceSource = video => {
    const previous = playerState;
    if (!previous || previous.window.closed) return;
    const sameVideo = previous.source === video;
    let stream;
    try {
      stream = video.captureStream();
    } catch {
      closePlayer();
      return;
    }
    previous.cleanup({ keepWindow: true, restoreAudio: !sameVideo });
    try {
      mountPlayer(previous.frame, video, stream, sameVideo ? previous.audio : undefined);
    } catch {
      stopStream(stream);
      playerState = null;
      notify();
      previous.window.close();
    }
  };

  const isOpen = () => {
    if (playerState?.window.closed) playerState.cleanup();
    return Boolean(playerState);
  };

  const openPlayer = async target => {
    const source = target instanceof HTMLVideoElement ? target : chooseVideo(target);
    if (isOpen()) {
      if (source && source !== playerState.source) replaceSource(source);
      playerState?.window.focus();
      return { ok: true, mode: 'player' };
    }
    if (!source) return { ok: false, message: t('errorVideoGone') };

    let stream;
    try {
      if (!source.captureStream) throw new DOMException(t('errorCaptureUnsupported'), 'NotSupportedError');
      stream = source.captureStream();
    } catch {
      try {
        return await openNativePip(source);
      } catch (error) {
        if (error.name === 'NotAllowedError') return installLaunchButton(target);
        return { ok: false, message: error.message };
      }
    }

    try {
      return await createPlayer(source, stream);
    } catch (error) {
      stopStream(stream);
      if (error.name === 'NotAllowedError') return installLaunchButton(target);
      return { ok: false, message: error.message };
    }
  };

  const placeWindow = async (frame, known) => {
    const result = await chrome.runtime.sendMessage({ type: 'FRAMEROAM_PLACE', known }).catch(() => null);
    if (!result?.ok) return;
    frame.windowId = result.windowId;
    frame.fullscreen = result.fullscreen;
    if (playerState?.frame === frame) playerState.revealControls();
  };

  const createPlayer = async (source, stream) => {
    const rect = source.getBoundingClientRect();
    const width = Math.max(680, Math.min(1280, Math.round(rect.width || 960)));
    const ratio = rect.width > 0 && rect.height > 0 ? rect.height / rect.width : 9 / 16;
    const placement = await chrome.runtime.sendMessage({ type: 'FRAMEROAM_PREPARE' }).catch(() => null);
    const bounds = placement?.bounds;
    const geometry = bounds
      ? `left=${bounds.left},top=${bounds.top},width=${bounds.width},height=${bounds.height}`
      : `width=${width},height=${Math.max(440, Math.round(width * ratio) + 72)}`;
    const playerWindow = window.open('', 'video-controller-player', `popup=yes,${geometry},resizable=yes,scrollbars=no`);
    if (!playerWindow) throw new DOMException(t('errorPopupBlocked'), 'NotAllowedError');

    const frame = { window: playerWindow, windowId: null, fullscreen: false };
    try {
      mountPlayer(frame, source, stream);
    } catch (error) {
      playerWindow.close();
      throw error;
    }
    playerWindow.focus();
    if (placement?.ok) placeWindow(frame, placement.known);
    return { ok: true, mode: 'player' };
  };

  const mountPlayer = (frame, source, stream, audio = { muted: source.muted, volume: source.volume }) => {
    const playerWindow = frame.window;
    const playerDocument = playerWindow.document;
    playerDocument.title = `${document.title || t('video')} · ${t('extensionName')}`;
    playerDocument.documentElement.lang = t('@@ui_locale').replace('_', '-');
    playerDocument.documentElement.dir = t('@@bidi_dir');
    const css = `
      :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
      *{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#030306;color:#f7f7fb}
      button,input{font:inherit}button{display:inline-grid;place-items:center;min-width:40px;height:40px;padding:0 12px;border:1px solid #ffffff1d;border-radius:11px;background:#16161df2;color:#f8f8ff;cursor:pointer;transition:background .16s,border-color .16s,transform .16s}
      button:hover{background:#292937;border-color:#ffffff35}button:active{transform:scale(.96)}button:focus-visible,input:focus-visible{outline:2px solid #9294ff;outline-offset:2px}
      .player{position:relative;width:100%;height:100%;overflow:hidden;background:#000}.stage{position:absolute;inset:0;overflow:hidden;background:#000}.stage video{position:absolute;left:50%;top:50%;max-width:none;max-height:none;object-fit:contain;background:#000;transform-origin:center}
      .ui{position:absolute;z-index:2;left:0;right:0;display:flex;align-items:center;gap:8px;padding:12px 16px;opacity:1;transform:translateY(0);transition:opacity .32s ease,transform .32s cubic-bezier(.4,0,.2,1);pointer-events:auto}
      .topbar{top:0;background:linear-gradient(#000c,transparent)}.bottombar{bottom:0;display:grid;gap:10px;padding-top:42px;background:linear-gradient(transparent,#000e)}
      .top-hidden .topbar{opacity:0;transform:translateY(-100%);pointer-events:none}.bottom-hidden .bottombar{opacity:0;transform:translateY(100%);pointer-events:none}
      .brand{display:flex;align-items:center;gap:9px;min-width:0}.brand-dot{width:10px;height:10px;border-radius:50%;background:#7778ff;box-shadow:0 0 18px #7778ff}.title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:650;color:#ffffffe8}.spacer{flex:1}.group{display:flex;align-items:center;gap:6px}.zoom{min-width:48px;text-align:center;font-size:12px;color:#ffffffb3}
      .timeline{width:100%;height:4px;margin:0;accent-color:#7b7dff;cursor:pointer}.control-row{display:flex;align-items:center;gap:9px}.time{min-width:112px;font-size:12px;font-variant-numeric:tabular-nums;color:#ffffffc2}.volume{width:min(110px,18vw);accent-color:#7b7dff}.primary{background:#696bf0;border-color:#8f91ff}.primary:hover{background:#7a7cf5}
      .toast{position:absolute;z-index:3;left:50%;top:50%;transform:translate(-50%,-44%);padding:10px 15px;border:1px solid #ffffff21;border-radius:12px;background:#101016f2;color:white;font-weight:700;opacity:0;pointer-events:none;transition:opacity .15s,transform .15s}.toast.visible{opacity:1;transform:translate(-50%,-50%)}
      .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
      @media(max-width:720px){.window-size,.zoom{display:none}.ui{padding-left:10px;padding-right:10px}.time{min-width:94px}.volume{width:76px}button{padding:0 10px}}
      @media(prefers-reduced-motion:reduce){button,.ui,.toast{transition:none}}
    `;
    try {
      const sheet = new playerWindow.CSSStyleSheet();
      sheet.replaceSync(css);
      playerDocument.adoptedStyleSheets = [sheet];
    } catch {
      const style = playerDocument.createElement('style');
      style.textContent = css;
      playerDocument.head.replaceChildren(style);
    }

    const make = (tag, className, text) => {
      const element = playerDocument.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    };
    const button = (label, title, handler, className = '') => {
      const element = make('button', className, label);
      element.type = 'button';
      element.title = title;
      element.setAttribute('aria-label', title);
      element.addEventListener('click', handler);
      return element;
    };

    const shell = make('main', 'player');
    const stage = make('section', 'stage');
    stage.setAttribute('aria-label', t('videoArea'));
    const mirror = playerDocument.createElement('video');
    const videoStream = new playerWindow.MediaStream(stream.getVideoTracks());
    mirror.srcObject = videoStream;
    mirror.autoplay = true;
    mirror.playsInline = true;
    mirror.controls = false;
    mirror.muted = true;
    stage.append(mirror);

    const topbar = make('header', 'ui topbar');
    const brand = make('div', 'brand');
    brand.append(make('span', 'brand-dot'), make('span', 'title', document.title || t('extensionName')));
    const topSpacer = make('span', 'spacer');
    const rotateButton = button('↻', t('rotate'), () => rotate());
    const zoomOutButton = button('−', t('zoomOut'), () => changeZoom(-0.1));
    const zoomLabel = make('span', 'zoom', '100%');
    const zoomInButton = button('+', t('zoomIn'), () => changeZoom(0.1));
    const resetButton = button(t('fit'), t('resetView'), () => resetView());
    const shrinkButton = button('▣−', t('windowSmaller'), () => playerWindow.resizeBy(-160, -90), 'window-size');
    const growButton = button('▣+', t('windowLarger'), () => playerWindow.resizeBy(160, 90), 'window-size');
    const fullscreenButton = button('⛶', t('fullscreen'), () => toggleFullscreen());
    topbar.append(brand, topSpacer, rotateButton, zoomOutButton, zoomLabel, zoomInButton, resetButton, shrinkButton, growButton, fullscreenButton);

    const bottombar = make('footer', 'ui bottombar');
    const timeline = make('input', 'timeline');
    timeline.type = 'range';
    timeline.step = '0.1';
    timeline.setAttribute('aria-label', t('timeline'));
    const controlRow = make('div', 'control-row');
    const playButton = button('▶', t('playPause'), () => togglePlay(), 'primary');
    const timeLabel = make('span', 'time', '0:00 / --:--');
    const volumeButton = button('🔊', t('mute'), () => toggleMute());
    const volume = make('input', 'volume');
    volume.type = 'range';
    volume.min = '0';
    volume.max = '1';
    volume.step = '0.05';
    volume.setAttribute('aria-label', t('volume'));
    controlRow.append(playButton, timeLabel, volumeButton, volume, make('span', 'spacer'));
    bottombar.append(timeline, controlRow);
    const toast = make('div', 'toast');
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    shell.append(stage, topbar, bottombar, toast);
    playerDocument.body.replaceChildren(shell);

    const cleanups = [];
    const listen = (target, event, handler, options) => {
      target.addEventListener(event, handler, options);
      cleanups.push(() => target.removeEventListener(event, handler, options));
    };
    const audioTarget = source;
    let rotation = 0;
    let zoom = 1;
    const edgeDwellMs = 1000;
    const controlHideMs = 2500;
    const hideTimers = { top: null, bottom: null };
    const dwellTimers = { top: null, bottom: null };
    let toastTimer;
    let clickTimer;
    let endedTimer;
    let pendingSwitch = false;
    let cleaned = false;

    const showToast = text => {
      clearTimeout(toastTimer);
      toast.textContent = text;
      toast.classList.add('visible');
      toastTimer = setTimeout(() => toast.classList.remove('visible'), 900);
    };
    const isFullscreen = () => Boolean(playerDocument.fullscreenElement) || frame.fullscreen;
    const cancelDwell = edge => {
      clearTimeout(dwellTimers[edge]);
      dwellTimers[edge] = null;
    };
    const showBar = edge => {
      clearTimeout(hideTimers[edge]);
      hideTimers[edge] = null;
      shell.classList.remove(`${edge}-hidden`);
    };
    const scheduleBarHide = edge => {
      clearTimeout(hideTimers[edge]);
      hideTimers[edge] = null;
      if (!isFullscreen() && source.paused) return;
      hideTimers[edge] = setTimeout(() => {
        shell.classList.add(`${edge}-hidden`);
        hideTimers[edge] = null;
      }, controlHideMs);
    };
    const scheduleHide = () => {
      scheduleBarHide('top');
      scheduleBarHide('bottom');
    };
    const revealControls = () => {
      cancelDwell('top');
      cancelDwell('bottom');
      showBar('top');
      showBar('bottom');
      scheduleHide();
    };
    const revealKeyboardControl = edge => {
      if (!isFullscreen()) {
        revealControls();
        return;
      }
      const other = edge === 'top' ? 'bottom' : 'top';
      cancelDwell(other);
      clearTimeout(hideTimers[other]);
      hideTimers[other] = null;
      shell.classList.add(`${other}-hidden`);
      cancelDwell(edge);
      showBar(edge);
      scheduleBarHide(edge);
    };
    const watchEdge = (edge, active) => {
      if (!isFullscreen()) return;
      if (!active) {
        cancelDwell(edge);
        if (!shell.classList.contains(`${edge}-hidden`)) scheduleBarHide(edge);
        return;
      }
      if (!shell.classList.contains(`${edge}-hidden`)) {
        cancelDwell(edge);
        clearTimeout(hideTimers[edge]);
        hideTimers[edge] = null;
        return;
      }
      if (dwellTimers[edge]) return;
      dwellTimers[edge] = setTimeout(() => {
        dwellTimers[edge] = null;
        showBar(edge);
      }, edgeDwellMs);
    };
    const formatTime = value => {
      if (!Number.isFinite(value)) return '--:--';
      const seconds = Math.max(0, Math.floor(value));
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const mm = String(minutes % 60).padStart(hours ? 2 : 1, '0');
      return `${hours ? `${hours}:` : ''}${mm}:${String(seconds % 60).padStart(2, '0')}`;
    };
    const bounds = () => {
      if (Number.isFinite(source.duration)) return { min: 0, max: source.duration };
      if (source.seekable.length) return { min: source.seekable.start(0), max: source.seekable.end(source.seekable.length - 1) };
      return { min: 0, max: Infinity };
    };
    const syncTimeline = () => {
      const range = bounds();
      timeline.disabled = !Number.isFinite(range.max) || range.max <= range.min;
      if (!timeline.disabled) {
        timeline.min = String(range.min);
        timeline.max = String(range.max);
        timeline.value = String(Math.max(range.min, Math.min(range.max, source.currentTime || 0)));
      }
      playButton.textContent = source.paused ? '▶' : 'Ⅱ';
      timeLabel.textContent = `${formatTime(source.currentTime)} / ${formatTime(range.max)}`;
    };
    function syncVolume() {
      volume.value = String(audioTarget.muted ? 0 : audioTarget.volume);
      volumeButton.textContent = audioTarget.muted || audioTarget.volume === 0 ? '🔇' : '🔊';
    }
    const layoutVideo = () => {
      const sideways = rotation % 180 !== 0;
      mirror.style.width = `${sideways ? stage.clientHeight : stage.clientWidth}px`;
      mirror.style.height = `${sideways ? stage.clientWidth : stage.clientHeight}px`;
      mirror.style.transform = `translate(-50%,-50%) rotate(${rotation}deg) scale(${zoom})`;
      zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    };
    const seek = seconds => {
      const range = bounds();
      const target = Math.max(range.min, Math.min(range.max, source.currentTime + seconds));
      if (Number.isFinite(target)) source.currentTime = target;
      syncTimeline();
      showToast(`${seconds > 0 ? '+' : '−'}${Math.abs(seconds)} ${t('secondsUnit')}`);
    };
    async function togglePlay() {
      try {
        if (source.paused) await source.play();
        else source.pause();
      } catch {
        showToast(t('startInOriginalTab'));
      }
    }
    function rotate() {
      rotation = (rotation + 90) % 360;
      layoutVideo();
      showToast(`${rotation}°`);
    }
    function changeZoom(amount) {
      zoom = Math.max(0.5, Math.min(2, Math.round((zoom + amount) * 10) / 10));
      layoutVideo();
      showToast(`${Math.round(zoom * 100)}%`);
    }
    function resetView() {
      rotation = 0;
      zoom = 1;
      layoutVideo();
      showToast(t('fit'));
    }
    async function toggleFullscreen() {
      try {
        if (playerDocument.fullscreenElement) await playerDocument.exitFullscreen();
        else if (frame.windowId !== null) {
          // The extension owns this window, so it can switch the whole window to fullscreen
          // without a click inside the player.
          const result = await chrome.runtime.sendMessage({ type: 'FRAMEROAM_FULLSCREEN', windowId: frame.windowId });
          if (!result?.ok) throw new Error(result?.message);
          frame.fullscreen = result.fullscreen;
          revealControls();
        } else await shell.requestFullscreen();
      } catch {
        showToast(t('fullscreenUnavailable'));
      }
    }
    function toggleMute() {
      audioTarget.muted = !audioTarget.muted;
      syncVolume();
      showToast(t(audioTarget.muted ? 'muted' : 'soundOn'));
    }
    function changeVolume(amount) {
      const current = audioTarget.muted ? 0 : audioTarget.volume;
      audioTarget.volume = Math.round(Math.max(0, Math.min(1, current + amount)) * 100) / 100;
      audioTarget.muted = audioTarget.volume === 0;
      syncVolume();
      showToast(`${t('volume')} ${Math.round(audioTarget.volume * 100)}%`);
    }
    function setPlaybackRate(rate) {
      const next = Math.round(Math.max(0.25, Math.min(2, rate)) * 4) / 4;
      source.playbackRate = next;
      showToast(`${t('playbackSpeed')} ${next}×`);
    }

    const onKeydown = event => {
      const inControl = ['INPUT', 'BUTTON'].includes(event.target?.tagName);
      if (event.key === 'Tab') {
        revealControls();
        return;
      }
      if (event.key === 'Escape' && frame.fullscreen) {
        event.preventDefault();
        toggleFullscreen();
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        event.stopImmediatePropagation();
        revealKeyboardControl('bottom');
        const seconds = event.ctrlKey && event.shiftKey ? 30 : event.ctrlKey ? 10 : 5;
        seek((event.key === 'ArrowLeft' ? -1 : 1) * seconds);
        return;
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopImmediatePropagation();
        revealKeyboardControl('bottom');
        changeVolume(event.key === 'ArrowUp' ? 0.05 : -0.05);
        return;
      }
      const speedDelta = event.shiftKey && event.code === 'Comma' ? -0.25
        : event.shiftKey && event.code === 'Period' ? 0.25
          : 0;
      if (speedDelta || (event.shiftKey && event.code === 'Digit0')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        revealKeyboardControl('bottom');
        setPlaybackRate(speedDelta ? source.playbackRate + speedDelta : 1);
        return;
      }
      if (inControl) {
        revealKeyboardControl(event.target.closest('.topbar') ? 'top' : 'bottom');
        return;
      }
      const key = event.key.toLowerCase();
      if (key === ' ') { event.preventDefault(); revealKeyboardControl('bottom'); togglePlay(); }
      else if (key === 'f') toggleFullscreen();
      else if (key === 'r') { revealKeyboardControl('top'); rotate(); }
      else if (key === 'm') { revealKeyboardControl('bottom'); toggleMute(); }
      else if (key === '+' || key === '=') { revealKeyboardControl('top'); changeZoom(0.1); }
      else if (key === '-') { revealKeyboardControl('top'); changeZoom(-0.1); }
      else if (key === '0') { revealKeyboardControl('top'); resetView(); }
    };
    const onStageClick = event => {
      if (event.detail !== 1) return;
      clearTimeout(clickTimer);
      clickTimer = setTimeout(togglePlay, 180);
    };
    const onStageDoubleClick = () => {
      clearTimeout(clickTimer);
      toggleFullscreen();
    };
    const onPointerMove = event => {
      if (!isFullscreen()) {
        revealControls();
        return;
      }
      watchEdge('top', event.clientY <= 72);
      watchEdge('bottom', event.clientY >= playerWindow.innerHeight - 104);
    };
    const onPointerLeave = () => {
      cancelDwell('top');
      cancelDwell('bottom');
      scheduleHide();
    };
    const onFullscreenChange = () => revealControls();
    const onPlay = () => { syncTimeline(); scheduleHide(); };
    const onPause = () => { syncTimeline(); isFullscreen() ? revealKeyboardControl('bottom') : revealControls(); };
    const onEnded = () => {
      if (!settings.closeOnEnd || isYoutubeAd(source)) return;
      clearTimeout(endedTimer);
      // Ads and playlists load the next media right after "ended"; close only if it stays finished.
      endedTimer = setTimeout(() => { if (source.ended) closePlayer(); }, endedGraceMs);
    };
    const onSourceReset = () => {
      clearTimeout(endedTimer);
      pendingSwitch = settings.followVideo;
    };
    const onSourcePlaying = () => {
      if (pendingSwitch) replaceSource(source);
    };
    const onDocumentPlaying = event => {
      const video = event.target;
      if (!settings.followVideo || video === source || !(video instanceof HTMLVideoElement) || video.muted) return;
      const rect = video.getBoundingClientRect();
      if (rect.width >= 200 && rect.height >= 120) replaceSource(video);
    };

    listen(stage, 'click', onStageClick);
    listen(stage, 'dblclick', onStageDoubleClick);
    listen(playerWindow, 'mousemove', onPointerMove, { passive: true });
    listen(playerDocument, 'mouseleave', onPointerLeave);
    listen(playerDocument, 'fullscreenchange', onFullscreenChange);
    listen(playerWindow, 'keydown', onKeydown, true);
    listen(source, 'timeupdate', syncTimeline);
    listen(source, 'durationchange', syncTimeline);
    listen(source, 'loadedmetadata', syncTimeline);
    listen(source, 'play', onPlay);
    listen(source, 'pause', onPause);
    listen(source, 'ended', onEnded);
    listen(source, 'emptied', onSourceReset);
    listen(source, 'loadstart', onSourceReset);
    listen(source, 'playing', onSourcePlaying);
    listen(document, 'playing', onDocumentPlaying, true);
    listen(audioTarget, 'volumechange', syncVolume);
    listen(stream, 'addtrack', event => {
      if (event.track.kind === 'video') videoStream.addTrack(event.track);
    });
    listen(stream, 'removetrack', event => {
      if (event.track.kind === 'video') videoStream.removeTrack(event.track);
    });
    listen(timeline, 'input', () => { source.currentTime = Number(timeline.value); });
    listen(volume, 'input', () => {
      audioTarget.volume = Number(volume.value);
      audioTarget.muted = audioTarget.volume === 0;
      syncVolume();
    });

    const resizeObserver = new playerWindow.ResizeObserver(layoutVideo);
    resizeObserver.observe(stage);
    const cleanup = ({ keepWindow = false, restoreAudio = true } = {}) => {
      if (cleaned) return;
      cleaned = true;
      Object.values(hideTimers).forEach(clearTimeout);
      Object.values(dwellTimers).forEach(clearTimeout);
      clearTimeout(toastTimer);
      clearTimeout(clickTimer);
      clearTimeout(endedTimer);
      resizeObserver.disconnect();
      cleanups.splice(0).forEach(remove => remove());
      mirror.pause();
      mirror.srcObject = null;
      stopStream(stream);
      if (restoreAudio) {
        source.volume = audio.volume;
        source.muted = audio.muted;
      }
      if (keepWindow) return;
      playerState = null;
      notify();
    };
    listen(playerWindow, 'pagehide', () => cleanup(), { once: true });
    listen(window, 'pagehide', () => playerWindow.close(), { once: true });

    playerState = { frame, window: playerWindow, source, audio, cleanup, revealControls };
    mirror.play().catch(() => showToast(t('mirrorPlaybackFailed')));
    layoutVideo();
    syncTimeline();
    syncVolume();
    revealControls();
    notify();
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'VIDEO_CONTROLLER_OPEN') return undefined;
    openPlayer(message.videoIndex)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, message: error.message }));
    return true;
  });

  globalThis.FrameRoamFocus = Object.freeze({
    open: openPlayer,
    close: closePlayer,
    isOpen,
    onChange: callback => subscribers.add(callback)
  });
})();
