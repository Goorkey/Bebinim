/**
 * Player adapters: YouTube and plain <video> expose the same small interface,
 * so the sync logic never needs to know which one is playing.
 *
 *   play() pause() seek(t) time() duration() setRate(r) setVolume(0..1) setMuted(b)
 *   isPlaying() ended() destroy()  (+ qualities() / setQuality(q) on YouTube)
 */

const abortError = () => new DOMException('Cancelled', 'AbortError');

/* ---------- YouTube ---------- */

const YT_ERRORS = {
  2: 'That YouTube link is not valid.',
  5: 'YouTube could not play this video in the browser.',
  100: 'That video is unavailable or private.',
  101: 'The owner of this video does not allow embedding.',
  150: 'The owner of this video does not allow embedding.',
  153: 'YouTube refused to embed this video. Try another one.',
};

let ytApi = null;
function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (!ytApi) {
    ytApi = new Promise((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { previous?.(); resolve(); };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.onerror = () => {
        ytApi = null;
        script.remove();
        reject(new Error('Could not load the YouTube player. Check your connection.'));
      };
      document.head.append(script);
    });
  }
  return ytApi;
}

async function createYouTubePlayer(host, id, handlers, signal) {
  await loadYouTubeApi();
  if (signal.aborted) throw abortError();

  host.replaceChildren();
  const mount = document.createElement('div');
  host.append(mount);

  return new Promise((resolve, reject) => {
    const S = { ENDED: 0, PLAYING: 1, BUFFERING: 3 };
    let yt = null;
    let ready = false;
    let state = -1;
    let destroyed = false;
    let qualitiesSent = false;

    const adapter = {
      play: () => yt.playVideo(),
      pause: () => yt.pauseVideo(),
      seek: (t) => yt.seekTo(t, true),
      time: () => yt.getCurrentTime() || 0,
      duration: () => yt.getDuration() || 0,
      setRate: (r) => { if (yt.getPlaybackRate() !== r) yt.setPlaybackRate(r); },
      setVolume: (v) => yt.setVolume(Math.round(v * 100)),
      setMuted: (m) => (m ? yt.mute() : yt.unMute()),
      isPlaying: () => state === S.PLAYING || state === S.BUFFERING,
      ended: () => state === S.ENDED,
      qualities: () => yt.getAvailableQualityLevels?.() || [],
      setQuality: (q) => yt.setPlaybackQuality(q),
      destroy() {
        if (destroyed) return;
        destroyed = true;
        try { yt?.destroy(); } catch { /* player already gone */ }
        host.replaceChildren();
      },
    };

    signal.addEventListener('abort', () => { adapter.destroy(); reject(abortError()); }, { once: true });

    yt = new window.YT.Player(mount, {
      videoId: id,
      playerVars: {
        controls: 0, disablekb: 1, playsinline: 1, rel: 0, fs: 0,
        modestbranding: 1, iv_load_policy: 3, origin: location.origin,
      },
      events: {
        onReady: () => { ready = true; resolve(adapter); },
        onStateChange: (e) => {
          state = e.data;
          handlers.onBuffering(state === S.BUFFERING);
          if (state === S.PLAYING && !qualitiesSent) {
            qualitiesSent = true;
            handlers.onQualities?.(adapter.qualities());
          }
          if (state === S.ENDED) handlers.onEnded();
        },
        onError: (e) => {
          const error = new Error(YT_ERRORS[e.data] || 'YouTube could not play this video.');
          if (ready) handlers.onError(error); else reject(error);
        },
      },
    });
  });
}

/* ---------- Uploaded file (<video>) ---------- */

function videoErrorMessage(error) {
  switch (error?.code) {
    case 2: return 'The video could not be downloaded. Check your connection.';
    case 3: return 'This device could not decode the video.';
    case 4: return 'This browser cannot play that file. MP4 (H.264) and WebM work best.';
    default: return 'The video could not be played.';
  }
}

function createFilePlayer(video, url, handlers, signal) {
  return new Promise((resolve, reject) => {
    const listeners = new AbortController();
    const on = (type, fn) => video.addEventListener(type, fn, { signal: listeners.signal });
    let ready = false;
    let destroyed = false;

    const adapter = {
      play: () => video.play(),
      pause: () => video.pause(),
      seek: (t) => { video.currentTime = t; },
      time: () => video.currentTime || 0,
      duration: () => (Number.isFinite(video.duration) ? video.duration : 0),
      setRate: (r) => { if (video.playbackRate !== r) video.playbackRate = r; },
      setVolume: (v) => { video.volume = v; },
      setMuted: (m) => { video.muted = m; },
      isPlaying: () => !video.paused && !video.ended,
      ended: () => video.ended,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        listeners.abort();
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.hidden = true;
      },
    };

    signal.addEventListener('abort', () => { adapter.destroy(); reject(abortError()); }, { once: true });

    on('loadedmetadata', () => { ready = true; resolve(adapter); });
    on('error', () => {
      const error = new Error(videoErrorMessage(video.error));
      if (ready) handlers.onError(error); else reject(error);
    });
    on('waiting', () => handlers.onBuffering(true));
    for (const type of ['playing', 'canplay', 'seeked']) on(type, () => handlers.onBuffering(false));
    on('ended', () => handlers.onEnded());

    video.hidden = false;
    video.preload = 'auto';
    video.src = url;
  });
}

/**
 * @param {{k:'yt',id:string}|{k:'file',u:string}} source
 * @param {{ytHost:HTMLElement, video:HTMLVideoElement, handlers:object}} ctx
 * @param {AbortSignal} signal  aborting cancels loading and tears the player down
 */
export function createPlayer(source, { ytHost, video, handlers }, signal) {
  return source.k === 'yt'
    ? createYouTubePlayer(ytHost, source.id, handlers, signal)
    : createFilePlayer(video, source.u, handlers, signal);
}
