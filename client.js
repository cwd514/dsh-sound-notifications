/**
 * DSH sound & notification plugin — Client half.
 *
 * Two independent surfaces, both driven by the forwarded Host events this
 * application exposes to the browser:
 *
 *   sounds         short synthesized tones (Web Audio, no asset files)
 *   notifications  desktop notifications (Web Notifications API, no service worker)
 *
 * Events and what they mean:
 *
 *   api-session/status running=true         -> agent started working
 *   api-session/status running=false        -> turn finished
 *   approval/request                        -> an approval is waiting (waterfall, passes next() through)
 *   user-questions/request                  -> the agent asked the user something (waterfall, passes next() through)
 *   api-session/error                       -> an agent failed
 *   deepseek-account/session-expired        -> the account credential was dropped
 *   deepseek-account/model-sign-in-required -> a model needs a sign-in
 *   goal/activation-changed                 -> goal auto-continuation armed or disarmed
 *   schedule/changed                        -> the durable task catalog changed
 *
 * `settings.general.item` carries two rows: `dsh-sound` (tones) and
 * `dsh-sound-notify` (desktop notifications). Preferences live in localStorage
 * because sound and notifications are per-browser concerns.
 * `window.__dshSound` exposes the same surfaces for manual testing and console
 * verification; it is deleted when the plugin unloads.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-sound',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect } = React;

    const NS = 'dsh-sound';
    const VERSION = '0.2.0';
    const SOUND_KEY = 'dsh.sound.v1';
    const NOTIFY_KEY = 'dsh.notify.v1';
    /** Master gain applied on top of the per-sound peak. */
    const MASTER_SCALE = 0.6;
    /** Minimum gap between two plays of the same kind. */
    const MIN_GAP_MS = 300;
    /** Ring-buffer length of the trigger logs behind `window.__dshSound`. */
    const LOG_LIMIT = 20;
    /** Longest detail a notification body carries before it is truncated. */
    const DETAIL_LIMIT = 160;
    const TRIGGERS = ['start', 'done', 'approval', 'question', 'error'];
    const NOTIFY_KINDS = ['done', 'approval', 'question', 'error', 'start', 'auth', 'goal', 'schedule'];
    /** Notifications that should stay on screen until the user acts (Chromium honors this). */
    const NOTIFY_STICKY = { approval: true, question: true };

    /** Translate for this namespace; replaced by `ctx.locale.bind(NS)` in apply(). */
    let translate = (key) => key;

    function soundDefaults() {
      return {
        enabled: true,
        volume: 50,
        events: { start: true, done: true, approval: true, question: true, error: true },
      };
    }

    function normalizeSound(raw) {
      const out = soundDefaults();
      if (raw === null || typeof raw !== 'object') return out;
      if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
      const volume = Number(raw.volume);
      if (Number.isFinite(volume)) out.volume = Math.max(0, Math.min(100, Math.round(volume)));
      if (raw.events !== null && typeof raw.events === 'object') {
        for (const kind of TRIGGERS) {
          if (typeof raw.events[kind] === 'boolean') out.events[kind] = raw.events[kind];
        }
      }
      return out;
    }

    function notifyDefaults() {
      return {
        /** Off until the user turns it on, which is also when permission is asked. */
        enabled: false,
        /** Only notify while the user is looking elsewhere. */
        onlyWhenHidden: true,
        /** Let the OS play its own notification sound (off = `silent`, our tone only). */
        osSound: true,
        events: {
          done: true, approval: true, question: true, error: true,
          start: false, auth: true, goal: true, schedule: false,
        },
      };
    }

    function normalizeNotify(raw) {
      const out = notifyDefaults();
      if (raw === null || typeof raw !== 'object') return out;
      if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
      if (typeof raw.onlyWhenHidden === 'boolean') out.onlyWhenHidden = raw.onlyWhenHidden;
      if (typeof raw.osSound === 'boolean') out.osSound = raw.osSound;
      if (raw.events !== null && typeof raw.events === 'object') {
        for (const kind of NOTIFY_KINDS) {
          if (typeof raw.events[kind] === 'boolean') out.events[kind] = raw.events[kind];
        }
      }
      return out;
    }

    // ---------------------------------------------------------------------
    // Settings stores (localStorage + subscribers; React subscribes)
    // ---------------------------------------------------------------------

    /**
     * One localStorage-backed settings store. Values are normalized on every
     * read and write, so a hand-edited or half-written value can neither break
     * a row nor reach an engine.
     */
    function createStore(key, normalize) {
      const listeners = new Set();
      let state = read();

      function read() {
        try {
          const raw = window.localStorage.getItem(key);
          return raw === null ? normalize(null) : normalize(JSON.parse(raw));
        } catch (error) {
          console.error('[dsh-sound] reading ' + key + ' failed, using defaults:', error);
          return normalize(null);
        }
      }

      function emit() {
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch (error) {
            console.error('[dsh-sound] a settings subscriber threw:', error);
          }
        }
      }

      return {
        get state() {
          return state;
        },
        /** Merge one patch (a nested `events` patch merges per kind too) and persist it. */
        update(patch) {
          const base = patch !== null && typeof patch === 'object' ? patch : {};
          const events = base.events !== null && typeof base.events === 'object' ? base.events : {};
          state = normalize({ ...state, ...base, events: { ...state.events, ...events } });
          try {
            window.localStorage.setItem(key, JSON.stringify(state));
          } catch (error) {
            console.error('[dsh-sound] saving ' + key + ' failed:', error);
          }
          emit();
          return state;
        },
        /** Re-render subscribers without changing a value (outside state changed). */
        bump() {
          emit();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    }

    const soundStore = createStore(SOUND_KEY, normalizeSound);
    const notifyStore = createStore(NOTIFY_KEY, normalizeNotify);

    // ---------------------------------------------------------------------
    // Audio engine
    // ---------------------------------------------------------------------

    let audioCtx = null;

    function audioSupported() {
      return typeof window !== 'undefined'
        && (typeof window.AudioContext === 'function' || typeof window.webkitAudioContext === 'function');
    }

    /**
     * Scale applied to every note peak at schedule time, read fresh on each
     * play so no shared node carries mutable state across mute/volume changes.
     *
     * @param force - preview/test plays ignore the master switch and keep an
     *   audible floor, so the verification hook never looks like a broken plugin.
     */
    function outputScale(force) {
      const { enabled, volume } = soundStore.state;
      if (force === true) return (Math.max(volume, 50) / 100) * MASTER_SCALE;
      if (!enabled) return 0;
      return (volume / 100) * MASTER_SCALE;
    }

    function ensureAudio() {
      if (audioCtx !== null) return audioCtx;
      if (!audioSupported()) return null;
      try {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        audioCtx = new Ctor();
      } catch (error) {
        console.error('[dsh-sound] AudioContext creation failed:', error);
        audioCtx = null;
      }
      return audioCtx;
    }

    /**
     * Envelope-shaped oscillator notes. Values are peaks before the master gain;
     * short attack, exponential release, every note under half a second.
     */
    const SOUNDS = {
      start: [
        { type: 'sine', freq: 760, at: 0, dur: 0.09, peak: 0.16 },
        { type: 'sine', freq: 1140, at: 0.06, dur: 0.09, peak: 0.1 },
      ],
      done: [
        { type: 'sine', freq: 880, at: 0, dur: 0.16, peak: 0.2 },
        { type: 'sine', freq: 1318.51, at: 0.11, dur: 0.34, peak: 0.22 },
        { type: 'sine', freq: 2637.02, at: 0.11, dur: 0.2, peak: 0.05 },
      ],
      approval: [
        { type: 'triangle', freq: 1318.51, at: 0, dur: 0.26, peak: 0.22 },
        { type: 'triangle', freq: 1567.98, at: 0.09, dur: 0.26, peak: 0.22 },
        { type: 'triangle', freq: 1975.53, at: 0.18, dur: 0.26, peak: 0.22 },
        { type: 'triangle', freq: 1318.51, at: 0.5, dur: 0.26, peak: 0.22 },
        { type: 'triangle', freq: 1567.98, at: 0.59, dur: 0.26, peak: 0.22 },
        { type: 'triangle', freq: 1975.53, at: 0.68, dur: 0.26, peak: 0.22 },
      ],
      question: [
        { type: 'sine', freq: 1046.5, at: 0, dur: 0.18, peak: 0.18 },
        { type: 'sine', freq: 1567.98, at: 0.1, dur: 0.5, peak: 0.2 },
      ],
      error: [
        { type: 'triangle', freq: 196, at: 0, dur: 0.22, peak: 0.2 },
        { type: 'triangle', freq: 130.81, at: 0.16, dur: 0.34, peak: 0.2 },
      ],
    };

    function scheduleSound(ac, kind, scale) {
      const notes = SOUNDS[kind];
      if (notes === undefined || !(scale > 0)) return false;
      const base = ac.currentTime + 0.01;
      for (const note of notes) {
        const at = base + note.at;
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = note.type;
        osc.frequency.setValueAtTime(note.freq, at);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, note.peak * scale), at + Math.min(0.02, note.dur * 0.3));
        gain.gain.exponentialRampToValueAtTime(0.0001, at + note.dur);
        osc.connect(gain);
        gain.connect(ac.destination);
        osc.start(at);
        osc.stop(at + note.dur + 0.03);
      }
      return true;
    }

    const lastPlayedAt = Object.create(null);
    const playLog = [];

    function record(kind, scheduled) {
      playLog.push({
        kind,
        at: new Date().toISOString(),
        scheduled,
        audioState: audioCtx === null ? null : audioCtx.state,
      });
      while (playLog.length > LOG_LIMIT) playLog.shift();
    }

    /**
     * Play one sound. Never throws: a disabled kind, a missing AudioContext, an
     * autoplay-blocked context, or any Web Audio failure only skips the sound.
     *
     * @param kind - one of TRIGGERS.
     * @param options.force - ignore the master switch, the per-kind toggle, and
     *   the throttle, and keep an audible floor (the row's preview buttons, the
     *   volume slider, and `window.__dshSound.play`).
     */
    function play(kind, options) {
      const force = options !== undefined && options.force === true;
      try {
        if (!force && (!soundStore.state.enabled || soundStore.state.events[kind] === false)) {
          record(kind, false);
          return false;
        }
        const ac = ensureAudio();
        if (ac === null) {
          record(kind, false);
          return false;
        }
        const now = Date.now();
        if (!force && lastPlayedAt[kind] !== undefined && now - lastPlayedAt[kind] < MIN_GAP_MS) {
          record(kind, false);
          return false;
        }
        lastPlayedAt[kind] = now;
        const scale = outputScale(force);
        if (ac.state === 'running') {
          const scheduled = scheduleSound(ac, kind, scale);
          record(kind, scheduled);
          return scheduled;
        }
        // Suspended (autoplay policy): resume, then play if the browser lets us.
        if (typeof ac.resume === 'function') {
          const pending = ac.resume();
          if (pending && typeof pending.then === 'function') {
            pending.then(
              () => {
                try {
                  record(kind, ac.state === 'running' ? scheduleSound(ac, kind, scale) : false);
                } catch (error) {
                  console.error('[dsh-sound] playing after resume failed:', error);
                  record(kind, false);
                }
              },
              () => record(kind, false),
            );
            return true;
          }
        }
        record(kind, false);
        return false;
      } catch (error) {
        console.error('[dsh-sound] play failed:', error);
        try {
          record(kind, false);
        } catch (ignored) {
          /* logging must never turn into a failure path */
        }
        return false;
      }
    }

    /** Play for a waterfall listener: sound failures must never reach the chain. */
    function safePlay(kind) {
      try {
        play(kind);
      } catch (error) {
        console.error('[dsh-sound] trigger failed:', error);
      }
    }

    // ---------------------------------------------------------------------
    // Desktop notifications
    // ---------------------------------------------------------------------

    /** The Notifications API needs a secure context: HTTPS, localhost, or 127.0.0.1. */
    function notificationSupported() {
      return typeof window !== 'undefined'
        && typeof window.Notification === 'function'
        && window.isSecureContext === true;
    }

    function notificationPermission() {
      if (!notificationSupported()) return 'unsupported';
      try {
        return window.Notification.permission;
      } catch (error) {
        return 'unsupported';
      }
    }

    /**
     * Ask for the notification permission. The browser only honors this from a
     * user gesture, so it is reached from the row's buttons. A denial cannot be
     * requested again from the page; the row then points at site settings.
     */
    function requestNotificationPermission() {
      if (!notificationSupported()) return Promise.resolve('unsupported');
      return new Promise((resolve) => {
        let settled = false;
        // Re-read the live permission instead of trusting the callback/promise
        // argument: `Notification.permission` is the authority the engine gates on.
        const finish = () => {
          if (settled) return;
          settled = true;
          notifyStore.bump();
          resolve(notificationPermission());
        };
        try {
          const pending = window.Notification.requestPermission(finish);
          if (pending !== null && typeof pending === 'object' && typeof pending.then === 'function') {
            pending.then(finish, finish);
          }
        } catch (error) {
          console.error('[dsh-sound] requesting notification permission failed:', error);
          finish();
        }
      });
    }

    /** True while the user is looking at this window (focused visible tab). */
    function windowIsVisible() {
      try {
        return document.visibilityState === 'visible' && document.hasFocus() === true;
      } catch (error) {
        return true;
      }
    }

    /** Small canvas-drawn PNG: notifications do not reliably render an SVG icon. */
    let notificationIconCache;
    function notificationIcon() {
      if (notificationIconCache !== undefined) return notificationIconCache;
      notificationIconCache = null;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const paint = canvas.getContext('2d');
        if (paint === null) return notificationIconCache;
        paint.fillStyle = '#4176e6';
        paint.beginPath();
        paint.arc(64, 64, 60, 0, Math.PI * 2);
        paint.fill();
        paint.fillStyle = '#ffffff';
        paint.beginPath();
        paint.moveTo(34, 52);
        paint.lineTo(52, 52);
        paint.lineTo(74, 34);
        paint.lineTo(74, 94);
        paint.lineTo(52, 76);
        paint.lineTo(34, 76);
        paint.closePath();
        paint.fill();
        paint.strokeStyle = '#ffffff';
        paint.lineWidth = 9;
        paint.lineCap = 'round';
        for (const radius of [20, 34]) {
          paint.beginPath();
          paint.arc(76, 64, radius, -0.95, 0.95);
          paint.stroke();
        }
        notificationIconCache = canvas.toDataURL('image/png');
      } catch (error) {
        console.error('[dsh-sound] drawing the notification icon failed:', error);
      }
      return notificationIconCache;
    }

    const notifyLog = [];
    const liveNotifications = new Set();

    function recordNotify(kind, shown, reason) {
      notifyLog.push({
        kind,
        at: new Date().toISOString(),
        shown,
        reason: reason === undefined ? null : reason,
        permission: notificationPermission(),
      });
      while (notifyLog.length > LOG_LIMIT) notifyLog.shift();
    }

    function truncateDetail(value) {
      const text = String(value === undefined || value === null ? '' : value).replace(/\s+/gu, ' ').trim();
      return text.length > DETAIL_LIMIT ? text.slice(0, DETAIL_LIMIT - 1) + '…' : text;
    }

    /**
     * Show one desktop notification. Never throws: a disabled switch, a missing
     * permission, a focused window, or any API failure only skips the banner.
     *
     * @param kind - one of NOTIFY_KINDS.
     * @param detail - optional body text.
     * @param options.force - ignore the master switch, the per-kind toggle, and
     *   the focus gate (the row's test button and the console hook). The browser
     *   permission still applies: it is not ours to bypass.
     * @returns the Notification so a caller can close it, or null.
     */
    function notify(kind, detail, options) {
      const force = options !== undefined && options.force === true;
      try {
        if (!force) {
          if (!notifyStore.state.enabled) {
            recordNotify(kind, false, 'off');
            return null;
          }
          if (notifyStore.state.events[kind] === false) {
            recordNotify(kind, false, 'kind-off');
            return null;
          }
          if (notifyStore.state.onlyWhenHidden && windowIsVisible()) {
            recordNotify(kind, false, 'visible');
            return null;
          }
        }
        if (!notificationSupported()) {
          recordNotify(kind, false, 'unsupported');
          return null;
        }
        if (notificationPermission() !== 'granted') {
          recordNotify(kind, false, 'permission');
          return null;
        }
        const body = truncateDetail(detail);
        const icon = notificationIcon();
        const notification = new window.Notification('DSH · ' + translate('notify.kinds.' + kind), {
          ...(body.length > 0 ? { body } : {}),
          ...(icon === null ? {} : { icon }),
          tag: 'dsh-sound:' + kind,
          requireInteraction: NOTIFY_STICKY[kind] === true,
          silent: notifyStore.state.osSound !== true,
        });
        liveNotifications.add(notification);
        notification.onclose = () => liveNotifications.delete(notification);
        notification.onclick = () => {
          try {
            window.focus();
          } catch (error) {
            /* focusing the window is best effort */
          }
          closeNotification(notification);
        };
        recordNotify(kind, true, null);
        return notification;
      } catch (error) {
        console.error('[dsh-sound] showing a notification failed:', error);
        recordNotify(kind, false, 'error');
        return null;
      }
    }

    function closeNotification(notification) {
      if (notification === null || notification === undefined) return;
      liveNotifications.delete(notification);
      try {
        notification.close();
      } catch (error) {
        /* already closed, or the browser dropped it */
      }
    }

    /** Close a notification as soon as the answer it announced arrives. */
    function closeWhenSettled(notification, pending) {
      if (notification === null || pending === null || typeof pending !== 'object') return;
      if (typeof pending.then !== 'function') return;
      pending.then(() => closeNotification(notification), () => closeNotification(notification));
    }

    function approvalDetail(request) {
      try {
        const source = request !== null && typeof request === 'object' ? request : {};
        const tool = typeof source.toolName === 'string' ? source.toolName : '';
        const reason = typeof source.displayReason === 'string'
          ? source.displayReason
          : typeof source.reason === 'string' ? source.reason : '';
        const text = truncateDetail(tool + (tool !== '' && reason !== '' ? ' — ' : '') + reason);
        return text.length > 0 ? text : translate('notify.body.approval');
      } catch (error) {
        return translate('notify.body.approval');
      }
    }

    function questionDetail(request) {
      try {
        const items = request !== null && typeof request === 'object' && Array.isArray(request.questions)
          ? request.questions
          : [];
        const first = items.length > 0 && items[0] !== null && typeof items[0] === 'object' ? items[0] : {};
        const text = truncateDetail(typeof first.question === 'string' ? first.question : '');
        return text.length > 0 ? text : translate('notify.body.question');
      } catch (error) {
        return translate('notify.body.question');
      }
    }

    // ---------------------------------------------------------------------
    // Host event wiring
    // ---------------------------------------------------------------------

    function subscribeHostEvents(ctx) {
      const disposers = [];
      const on = (event, listener) => {
        disposers.push(ctx.remote.$on(event, listener));
      };

      on('api-session/status', (sessionId, running) => {
        // Only the two reported edges react; an unexpected payload stays silent.
        if (running === true) {
          safePlay('start');
          notify('start', translate('notify.body.start'));
        } else if (running === false) {
          safePlay('done');
          notify('done', translate('notify.body.done'));
        }
      });
      on('api-session/error', (sessionId, message) => {
        safePlay('error');
        notify('error', typeof message === 'string' ? message : translate('notify.body.error'));
      });
      // Both of these are Host waterfalls: call `next` and hand its own promise
      // back untouched, so the approval panel and the question card still
      // receive their request. The notification closes once that promise
      // settles, i.e. the moment the user answers.
      on('approval/request', (request, next) => {
        safePlay('approval');
        const answer = typeof next === 'function' ? next() : undefined;
        closeWhenSettled(notify('approval', approvalDetail(request)), answer);
        return answer;
      });
      on('user-questions/request', (request, next) => {
        safePlay('question');
        const answer = typeof next === 'function' ? next() : undefined;
        closeWhenSettled(notify('question', questionDetail(request)), answer);
        return answer;
      });
      on('deepseek-account/session-expired', () => {
        notify('auth', translate('notify.body.authExpired'));
      });
      on('deepseek-account/model-sign-in-required', () => {
        notify('auth', translate('notify.body.authSignIn'));
      });
      on('goal/activation-changed', (payload) => {
        const goal = payload !== null && typeof payload === 'object' ? payload.goal : undefined;
        if (goal === undefined || goal === null) return;
        notify('goal', translate(goal.activation === 'armed' ? 'notify.body.goalArmed' : 'notify.body.goalDisarmed'));
      });
      on('schedule/changed', () => {
        notify('schedule', translate('notify.body.schedule'));
      });

      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch (error) {
            console.error('[dsh-sound] removing a listener failed:', error);
          }
        }
      };
    }

    /** Browsers start the AudioContext suspended until a user gesture. */
    function attachUnlockGesture() {
      const onGesture = () => {
        const ac = ensureAudio();
        if (ac === null) {
          detach();
          return;
        }
        if (ac.state === 'running') {
          detach();
          return;
        }
        const pending = typeof ac.resume === 'function' ? ac.resume() : undefined;
        if (pending && typeof pending.then === 'function') pending.then(detach, () => {});
        else detach();
      };
      const detach = () => {
        window.removeEventListener('pointerdown', onGesture, true);
        window.removeEventListener('keydown', onGesture, true);
        window.removeEventListener('touchstart', onGesture, true);
      };
      window.addEventListener('pointerdown', onGesture, true);
      window.addEventListener('keydown', onGesture, true);
      window.addEventListener('touchstart', onGesture, true);
      return detach;
    }

    // ---------------------------------------------------------------------
    // Styles (copied from the host switch/row patterns, tokens only)
    // ---------------------------------------------------------------------

    const CSS = [
      '.dswsnd-row{display:flex;flex-direction:column;gap:8px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08))}',
      '.dswsnd-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}',
      '.dswsnd-texts{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.dswsnd-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px;margin:0}',
      '.dswsnd-desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin:0}',
      '.dswsnd-body{display:flex;flex-direction:column;gap:6px}',
      '.dswsnd-body[data-disabled="true"]{opacity:.5}',
      '.dswsnd-eventRow{display:flex;align-items:center;gap:8px;min-height:24px}',
      '.dswsnd-eventLabel{flex:1 1 auto;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
      '.dswsnd-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));cursor:pointer}',
      '.dswsnd-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}',
      '.dswsnd-switch:disabled{cursor:default;opacity:.5}',
      '.dswsnd-switch:focus-visible{outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.dswsnd-thumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-layer-1));transition:transform 120ms ease}',
      '.dswsnd-switch[aria-checked="false"] .dswsnd-thumb{background:var(--dsw-alias-switch-thumb, var(--dsw-alias-border-l2))}',
      '.dswsnd-switch[aria-checked="true"] .dswsnd-thumb{transform:translateX(16px)}',
      '.dswsnd-preview{display:flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;cursor:pointer}',
      '.dswsnd-preview:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}',
      '.dswsnd-preview:focus-visible{outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.dswsnd-preview:disabled{cursor:default;opacity:.4}',
      '.dswsnd-volume{display:flex;align-items:center;gap:10px;padding-top:2px}',
      '.dswsnd-volumeLabel{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;flex:0 0 auto}',
      '.dswsnd-range{flex:1 1 auto;height:20px;accent-color:var(--dsw-alias-brand-primary);background:transparent}',
      '.dswsnd-volumeValue{flex:0 0 auto;min-width:38px;text-align:right;color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}',
      '.dswsnd-note{color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px;margin:0}',
      '.dswsnd-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:2px}',
      '.dswsnd-button{box-sizing:border-box;height:28px;padding:0 12px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;cursor:pointer}',
      '.dswsnd-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))}',
      '.dswsnd-button:disabled{cursor:default;opacity:.5}',
      '.dswsnd-button:focus-visible{outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.dswsnd-button[data-primary="true"]{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground, #fff)}',
      '.dswsnd-status{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
      '.dswsnd-status[data-ok="true"]{color:var(--dsw-alias-state-success-primary)}',
      '.dswsnd-caption{color:var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary));font-size:12px;line-height:18px;padding-top:4px}',
      '.dswsnd-grid{display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:4px 16px}',
    ].join('');

    function installStyles() {
      const tag = document.createElement('style');
      tag.dataset.dshSound = '1';
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        try {
          tag.remove();
        } catch (error) {
          console.error('[dsh-sound] removing the stylesheet failed:', error);
        }
      };
    }

    // ---------------------------------------------------------------------
    // Settings row
    // ---------------------------------------------------------------------

    /** Host switch markup: the visual state keys off aria-checked only. */
    function Switch({ checked, onChange, label, disabled }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label,
        title: label,
        disabled: disabled === true,
        className: 'dswsnd-switch',
        onClick: () => onChange(!checked),
      }, h('span', { className: 'dswsnd-thumb' }));
    }

    function SoundRow(props) {
      const t = props.t !== undefined ? props.t : (key) => key;
      const [state, setState] = useState(soundStore.state);

      useEffect(() => soundStore.subscribe(() => setState(soundStore.state)), []);

      const toggleMaster = () => {
        const next = !state.enabled;
        soundStore.update({ enabled: next });
        // Immediate confirmation that the browser can actually produce sound.
        if (next) play('done', { force: true });
      };

      const rows = TRIGGERS.map((kind) => {
        const label = t('events.' + kind);
        const on = state.events[kind] !== false;
        return h('div', { className: 'dswsnd-eventRow', key: kind },
          h('span', { className: 'dswsnd-eventLabel' }, label),
          h(Switch, {
            checked: on,
            disabled: !state.enabled,
            label,
            onChange: (value) => soundStore.update({ events: { [kind]: value } }),
          }),
          h('button', {
            type: 'button',
            className: 'dswsnd-preview',
            disabled: !state.enabled || !on,
            'aria-label': t('preview') + ': ' + label,
            title: t('preview'),
            onClick: () => play(kind, { force: true }),
          }, '\u266a'),
        );
      });

      return h('div', { className: 'dswsnd-row' },
        h('div', { className: 'dswsnd-head' },
          h('div', { className: 'dswsnd-texts' },
            h('p', { className: 'dswsnd-title' }, t('title')),
            h('p', { className: 'dswsnd-desc' }, t('description')),
          ),
          h(Switch, {
            checked: state.enabled,
            label: t('master'),
            onChange: toggleMaster,
          }),
        ),
        h('div', { className: 'dswsnd-body', 'data-disabled': state.enabled ? 'false' : 'true' },
          rows,
          h('div', { className: 'dswsnd-volume' },
            h('span', { className: 'dswsnd-volumeLabel' }, t('volume')),
            h('input', {
              type: 'range',
              className: 'dswsnd-range',
              min: 0,
              max: 100,
              step: 5,
              value: state.volume,
              disabled: !state.enabled,
              'aria-label': t('volume'),
              onChange: (event) => soundStore.update({ volume: Number(event.currentTarget.value) }),
              onPointerUp: () => play('start', { force: true }),
            }),
            h('span', { className: 'dswsnd-volumeValue' }, state.volume + '%'),
          ),
        ),
        audioSupported() ? null : h('p', { className: 'dswsnd-note' }, t('unavailable')),
      );
    }

    // ---------------------------------------------------------------------
    // Notification row
    // ---------------------------------------------------------------------

    function NotifyRow(props) {
      const t = props.t !== undefined ? props.t : (key) => key;
      const [state, setState] = useState(notifyStore.state);
      const [permission, setPermission] = useState(notificationPermission());

      useEffect(() => notifyStore.subscribe(() => setState(notifyStore.state)), []);
      // The permission also changes outside this page (site settings), and a
      // request resolves asynchronously, so re-read it whenever focus returns.
      useEffect(() => {
        const sync = () => setPermission(notificationPermission());
        sync();
        window.addEventListener('focus', sync);
        document.addEventListener('visibilitychange', sync);
        return () => {
          window.removeEventListener('focus', sync);
          document.removeEventListener('visibilitychange', sync);
        };
      }, []);

      const supported = notificationSupported();
      const ask = () => requestNotificationPermission().then((value) => setPermission(value));
      const toggleMaster = () => {
        const next = !state.enabled;
        notifyStore.update({ enabled: next });
        if (!next) return;
        // Turning it on is a user gesture: the right moment to ask, and to show
        // one confirmation banner when the permission is already there.
        if (permission === 'granted') notify('done', t('notify.body.test'), { force: true });
        else if (permission === 'default') ask();
      };

      const permissionControls = [];
      if (!supported) {
        permissionControls.push(h('span', { className: 'dswsnd-note', key: 'unsupported' }, t('notify.unsupported')));
      } else if (permission === 'granted') {
        permissionControls.push(h('span', { className: 'dswsnd-status', 'data-ok': 'true', key: 'granted' }, t('notify.permission.granted')));
        permissionControls.push(h('button', {
          type: 'button',
          className: 'dswsnd-button',
          key: 'test',
          disabled: !state.enabled,
          onClick: () => notify('done', t('notify.body.test'), { force: true }),
        }, t('notify.permission.test')));
      } else if (permission === 'denied') {
        permissionControls.push(h('span', { className: 'dswsnd-note', key: 'denied' }, t('notify.permission.denied')));
        permissionControls.push(h('button', {
          type: 'button',
          className: 'dswsnd-button',
          key: 'recheck',
          onClick: () => setPermission(notificationPermission()),
        }, t('notify.permission.recheck')));
      } else {
        permissionControls.push(h('button', {
          type: 'button',
          className: 'dswsnd-button',
          'data-primary': 'true',
          key: 'ask',
          disabled: !state.enabled,
          onClick: ask,
        }, t('notify.permission.ask')));
        permissionControls.push(h('span', { className: 'dswsnd-status', key: 'hint' }, t('notify.permission.hint')));
      }

      const optionRows = [['onlyWhenHidden', t('notify.onlyWhenHidden')], ['osSound', t('notify.osSound')]]
        .map(([key, label]) => h('div', { className: 'dswsnd-eventRow', key },
          h('span', { className: 'dswsnd-eventLabel' }, label),
          h(Switch, {
            checked: state[key] === true,
            disabled: !state.enabled,
            label,
            onChange: (value) => notifyStore.update({ [key]: value }),
          }),
        ));

      const kindRows = NOTIFY_KINDS.map((kind) => {
        const label = t('notify.kinds.' + kind);
        return h('div', { className: 'dswsnd-eventRow', key: kind },
          h('span', { className: 'dswsnd-eventLabel' }, label),
          h(Switch, {
            checked: state.events[kind] !== false,
            disabled: !state.enabled,
            label,
            onChange: (value) => notifyStore.update({ events: { [kind]: value } }),
          }),
        );
      });

      return h('div', { className: 'dswsnd-row' },
        h('div', { className: 'dswsnd-head' },
          h('div', { className: 'dswsnd-texts' },
            h('p', { className: 'dswsnd-title' }, t('notify.title')),
            h('p', { className: 'dswsnd-desc' }, t('notify.description')),
          ),
          h(Switch, {
            checked: state.enabled,
            // An unsupported origin cannot switch it on, but must still be able
            // to switch off a value stored while notifications were available.
            disabled: !supported && state.enabled !== true,
            label: t('notify.master'),
            onChange: toggleMaster,
          }),
        ),
        h('div', { className: 'dswsnd-body', 'data-disabled': state.enabled ? 'false' : 'true' },
          h('div', { className: 'dswsnd-actions' }, permissionControls),
          optionRows,
          h('div', { className: 'dswsnd-caption' }, t('notify.kindsLabel')),
          h('div', { className: 'dswsnd-grid' }, kindRows),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // Dictionaries
    // ---------------------------------------------------------------------

    const JA = {
      title: '効果音',
      description: '応答完了・承認待ち・エラーなどを音で知らせます',
      master: '効果音を鳴らす',
      volume: '音量',
      preview: '試聴',
      unavailable: 'このブラウザは Web Audio に対応していないため、音は鳴りません',
      'events.start': '処理開始',
      'events.done': '応答完了',
      'events.approval': '承認待ち',
      'events.question': '質問',
      'events.error': 'エラー',
      'notify.title': 'デスクトップ通知',
      'notify.description': 'アプリを見ていない間に、応答完了・承認待ち・エラーなどをOS通知で知らせます',
      'notify.master': '通知を送る',
      'notify.permission.ask': '通知を許可する',
      'notify.permission.hint': 'クリックするとブラウザが許可を確認します',
      'notify.permission.granted': '許可済み',
      'notify.permission.test': 'テスト通知',
      'notify.permission.denied': 'ブラウザでブロックされています。アドレスバー左のサイト設定で通知を許可してください',
      'notify.permission.recheck': '再確認',
      'notify.onlyWhenHidden': 'タブが非アクティブのときだけ通知する',
      'notify.osSound': 'OSの通知音も鳴らす',
      'notify.kindsLabel': '通知する種類',
      'notify.unsupported': 'この環境では通知を使えません（HTTPS または localhost で開く必要があります）',
      'notify.kinds.done': '応答完了',
      'notify.kinds.approval': '承認待ち',
      'notify.kinds.question': '質問',
      'notify.kinds.error': 'エラー',
      'notify.kinds.start': '処理開始',
      'notify.kinds.auth': '再ログイン',
      'notify.kinds.goal': 'ゴール継続',
      'notify.kinds.schedule': 'スケジュール',
      'notify.body.done': '応答が完了しました',
      'notify.body.start': '処理を開始しました',
      'notify.body.approval': '承認待ちの操作があります',
      'notify.body.question': 'エージェントから質問があります',
      'notify.body.error': 'エラーが発生しました',
      'notify.body.authExpired': 'ログインの有効期限が切れました。再ログインしてください',
      'notify.body.authSignIn': 'モデルの利用にサインインが必要です',
      'notify.body.goalArmed': 'ゴールの自動継続を開始しました',
      'notify.body.goalDisarmed': 'ゴールの自動継続を停止しました',
      'notify.body.schedule': 'スケジュールタスクが更新されました',
      'notify.body.test': 'これはテスト通知です',
    };

    const EN = {
      title: 'Sounds',
      description: 'Play a tone when a run finishes, an approval or question waits, or an error occurs',
      master: 'Play sounds',
      volume: 'Volume',
      preview: 'Preview',
      unavailable: 'This browser has no Web Audio support, so no sound will play',
      'events.start': 'Run started',
      'events.done': 'Run finished',
      'events.approval': 'Approval waiting',
      'events.question': 'Question asked',
      'events.error': 'Error',
      'notify.title': 'Desktop notifications',
      'notify.description': 'Tell me through the OS while I am away: run finished, approval waiting, errors',
      'notify.master': 'Send notifications',
      'notify.permission.ask': 'Allow notifications',
      'notify.permission.hint': 'Your browser will ask for permission',
      'notify.permission.granted': 'Allowed',
      'notify.permission.test': 'Test notification',
      'notify.permission.denied': 'Blocked by the browser. Allow notifications under the site settings in the address bar.',
      'notify.permission.recheck': 'Check again',
      'notify.onlyWhenHidden': 'Only while the tab is inactive',
      'notify.osSound': 'Also play the OS notification sound',
      'notify.kindsLabel': 'Notify me about',
      'notify.unsupported': 'Notifications are unavailable here (needs HTTPS or localhost)',
      'notify.kinds.done': 'Run finished',
      'notify.kinds.approval': 'Approval waiting',
      'notify.kinds.question': 'Question asked',
      'notify.kinds.error': 'Error',
      'notify.kinds.start': 'Run started',
      'notify.kinds.auth': 'Sign-in needed',
      'notify.kinds.goal': 'Goal continuation',
      'notify.kinds.schedule': 'Schedule',
      'notify.body.done': 'The run finished',
      'notify.body.start': 'The agent started working',
      'notify.body.approval': 'An operation is waiting for your approval',
      'notify.body.question': 'The agent asked you a question',
      'notify.body.error': 'Something failed',
      'notify.body.authExpired': 'Your sign-in expired. Please sign in again',
      'notify.body.authSignIn': 'A model requires you to sign in',
      'notify.body.goalArmed': 'Goal auto-continuation started',
      'notify.body.goalDisarmed': 'Goal auto-continuation stopped',
      'notify.body.schedule': 'The scheduled tasks changed',
      'notify.body.test': 'This is a test notification',
    };

    const ZH = {
      title: '提示音',
      description: '任务完成、等待确认、提问或出错时播放提示音',
      master: '播放提示音',
      volume: '音量',
      preview: '试听',
      unavailable: '当前浏览器不支持 Web Audio，无法播放声音',
      'events.start': '开始处理',
      'events.done': '回答完成',
      'events.approval': '等待确认',
      'events.question': '收到提问',
      'events.error': '出错',
      'notify.title': '桌面通知',
      'notify.description': '在你不看着窗口时，用系统通知告诉你完成、等待确认或出错',
      'notify.master': '发送通知',
      'notify.permission.ask': '允许通知',
      'notify.permission.hint': '点击后浏览器会询问是否允许',
      'notify.permission.granted': '已允许',
      'notify.permission.test': '测试通知',
      'notify.permission.denied': '已被浏览器阻止，请在地址栏的网站设置中允许通知',
      'notify.permission.recheck': '重新检查',
      'notify.onlyWhenHidden': '仅在标签页非活跃时通知',
      'notify.osSound': '同时播放系统通知音',
      'notify.kindsLabel': '通知类型',
      'notify.unsupported': '当前环境无法使用通知（需要 HTTPS 或 localhost）',
      'notify.kinds.done': '回答完成',
      'notify.kinds.approval': '等待确认',
      'notify.kinds.question': '收到提问',
      'notify.kinds.error': '出错',
      'notify.kinds.start': '开始处理',
      'notify.kinds.auth': '需要重新登录',
      'notify.kinds.goal': '目标续跑',
      'notify.kinds.schedule': '计划任务',
      'notify.body.done': '回答已完成',
      'notify.body.start': '已开始处理',
      'notify.body.approval': '有操作等待你确认',
      'notify.body.question': '智能体有问题要问你',
      'notify.body.error': '发生了错误',
      'notify.body.authExpired': '登录已过期，请重新登录',
      'notify.body.authSignIn': '使用该模型需要先登录',
      'notify.body.goalArmed': '目标自动续跑已开始',
      'notify.body.goalDisarmed': '目标自动续跑已停止',
      'notify.body.schedule': '计划任务已更新',
      'notify.body.test': '这是一条测试通知',
    };

    // ---------------------------------------------------------------------
    // Verification / manual-testing hook
    // ---------------------------------------------------------------------

    function installDebugHook() {
      const api = {
        version: VERSION,
        // --- sounds ---
        play: (kind, options) => play(kind, { ...(options || {}), force: true }),
        settings: () => JSON.parse(JSON.stringify(soundStore.state)),
        set: (patch) => JSON.parse(JSON.stringify(soundStore.update(patch || {}))),
        lastPlayed: () => playLog.map((entry) => ({ ...entry })),
        state: () => ({
          supported: audioSupported(),
          audioState: audioCtx === null ? null : audioCtx.state,
          scale: outputScale(false),
          forcedScale: outputScale(true),
        }),
        // --- notifications ---
        notify: (kind, detail) => notify(kind, detail === undefined ? translate('notify.body.test') : detail, { force: true }),
        notifySupported: () => notificationSupported(),
        notifyPermission: () => notificationPermission(),
        requestNotifyPermission: () => requestNotificationPermission(),
        notifySettings: () => JSON.parse(JSON.stringify(notifyStore.state)),
        setNotify: (patch) => JSON.parse(JSON.stringify(notifyStore.update(patch || {}))),
        lastNotified: () => notifyLog.map((entry) => ({ ...entry })),
        closeNotifications: () => {
          const count = liveNotifications.size;
          for (const notification of [...liveNotifications]) closeNotification(notification);
          return count;
        },
      };
      window.__dshSound = api;
      return () => {
        if (window.__dshSound === api) delete window.__dshSound;
        for (const notification of [...liveNotifications]) closeNotification(notification);
      };
    }

    // ---------------------------------------------------------------------
    // Plugin body
    // ---------------------------------------------------------------------

    const inject = ['slots', 'locale', 'remote'];

    function apply(ctx) {
      translate = ctx.locale.bind(NS);

      ctx.effect(() => ctx.locale.register(NS, { ja: JA, en: EN, zh: ZH }), 'dsh-sound: dictionaries');
      ctx.effect(() => installStyles(), 'dsh-sound: styles');
      ctx.effect(() => subscribeHostEvents(ctx), 'dsh-sound: host event listeners');
      ctx.effect(() => attachUnlockGesture(), 'dsh-sound: audio unlock');
      ctx.effect(() => installDebugHook(), 'dsh-sound: verification hook');

      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'dsh-sound',
        order: 25,
        locale: NS,
      }, SoundRow));

      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'dsh-sound-notify',
        order: 26,
        locale: NS,
      }, NotifyRow));
    }

    return { inject, apply };
  },
});
