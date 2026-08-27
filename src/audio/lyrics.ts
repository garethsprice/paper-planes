// Lyric capture via the Web Speech API. Chrome's recogniser listens to the
// microphone only (it cannot be fed a stream or the tab) and sends audio to
// Google, so this works in mic-listening mode and needs the network.
//
// Sung words are hard for ASR and a wrong word is worse than none, so the
// gate is strict: final results only (interim guesses are never shown), a
// confidence floor that rises for shorter phrases, whole alphabetic words
// only, a stoplist of function words, and no phrase that is mostly stoplist.
// Accepted phrases are handed to the caller, who decides *when* to show
// them (see main.ts — frisson moments only).
//
// Listening streams mic audio for as long as the session is open, so a
// session that hears nothing for `idleTimeoutS` (instrumental music, silence,
// a dropped connection) is stopped and retried after an exponentially
// growing pause; Chrome's `network` error is treated the same way rather
// than as fatal, since its continuous mode drops the connection after a
// minute or two. Any final result resets the backoff.

import {
  LYRICS_MIN_CONFIDENCE, LYRICS_MIN_CONFIDENCE_SHORT, LYRICS_MAX_WORDS, LYRICS_MIN_WORD_LEN,
  LYRICS_MIN_CONTENT_RATIO, LYRICS_FRESH_S, LYRICS_MIN_INTERVAL_S, BANNER_HOLD_S, LYRICS_FALLBACK_S, LYRICS_FALLBACK_ENERGY,
  LYRICS_IDLE_TIMEOUT_S, LYRICS_BACKOFF_BASE_S, LYRICS_BACKOFF_MAX_S,
} from '../constants.ts';

/** Live-tunable gate and timing (the debug panel binds sliders to these). */
export const lyricsSettings = {
  minConfidence: LYRICS_MIN_CONFIDENCE,
  minConfidenceShort: LYRICS_MIN_CONFIDENCE_SHORT,
  maxWords: LYRICS_MAX_WORDS,
  minWordLen: LYRICS_MIN_WORD_LEN,
  /** Fraction of words that must be content (non-filler); 0 allows all-filler. */
  minContentRatio: LYRICS_MIN_CONTENT_RATIO,
  freshS: LYRICS_FRESH_S,
  minIntervalS: LYRICS_MIN_INTERVAL_S,
  holdS: BANNER_HOLD_S,
  fallbackS: LYRICS_FALLBACK_S,
  fallbackEnergy: LYRICS_FALLBACK_ENERGY,
  /** Stop listening after this long with no final result, then back off. */
  idleTimeoutS: LYRICS_IDLE_TIMEOUT_S,
  backoffBaseS: LYRICS_BACKOFF_BASE_S,
  backoffMaxS: LYRICS_BACKOFF_MAX_S,
};

/** One thing the recogniser reported — for the live feed. */
export type LyricEvent = {
  kind: 'interim' | 'final' | 'error' | 'state';
  transcript: string;
  confidence: number;
  accepted: boolean;
  /** Why a final result was rejected, or '' when accepted. */
  reason: string;
  at: number;
};

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type RecognitionEvent = {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string; confidence: number }; length: number }>;
};

const STOP = new Set([
  'the', 'and', 'but', 'you', 'your', 'yeah', 'oh', 'ooh', 'ah', 'uh', 'la', 'na', 'hey',
  'that', 'this', 'with', 'for', 'was', 'are', 'not', 'its', "it's", 'got', 'get', 'just',
  'like', 'what', 'when', 'where', 'who', 'how', 'why', 'all', 'can', 'cant', "can't",
  'dont', "don't", 'im', "i'm", 'ive', "i've", 'youre', "you're", 'theyre', 'were',
  'been', 'have', 'has', 'had', 'will', 'would', 'could', 'should', 'there', 'their',
  'from', 'into', 'onto', 'out', 'over', 'under', 'than', 'then', 'them', 'they', 'him',
  'her', 'his', 'she', 'our', 'ours', 'yours', 'one', 'two', 'gonna', 'wanna', 'gotta',
  // short function words: filler, never content, never a reason to reject
  'a', 'i', 'of', 'to', 'in', 'on', 'at', 'by', 'as', 'is', 'it', 'be', 'do', 'go', 'me',
  'my', 'no', 'so', 'up', 'we', 'or', 'if', 'an', 'am', 'us',
]);

export type Lyrics = {
  supported: boolean;
  enabled: boolean;
  listening: boolean;
  lastError: string;
  /** performance.now() at which a backed-off retry will start, or 0 when not paused. */
  retryAt: number;
  /** Consecutive sessions that heard nothing (or failed); sets the backoff. */
  failures: number;
  /** Most recent accepted phrases, newest last. */
  recent: { text: string; at: number; confidence: number }[];
  /** Live feed for the debug panel, newest last (capped). */
  feed: LyricEvent[];
  start: () => void;
  stop: () => void;
};

export function createLyrics(onPhrase: (text: string, confidence: number) => void): Lyrics {
  const w = window as unknown as {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  const lyrics: Lyrics = {
    supported: !!Ctor,
    enabled: true,
    listening: false,
    lastError: '',
    retryAt: 0,
    failures: 0,
    recent: [],
    feed: [],
    start: () => {},
    stop: () => {},
  };
  const push = (e: Omit<LyricEvent, 'at'>): void => {
    lyrics.feed.push({ ...e, at: performance.now() });
    if (lyrics.feed.length > 60) lyrics.feed.shift();
  };
  if (!Ctor) {
    push({ kind: 'error', transcript: 'speech recognition not available in this browser', confidence: 0, accepted: false, reason: '' });
    return lyrics;
  }

  let rec: Recognition | null = null;
  let wantListening = false;
  let backingOff = false;
  let lastResultAt = 0;
  let idleTimer: number | undefined;
  let retryTimer: number | undefined;
  const state = (transcript: string): void =>
    push({ kind: 'state', transcript, confidence: 0, accepted: false, reason: '' });

  /** Pause listening and schedule a retry; the pause doubles per consecutive failure. */
  const enterBackoff = (why: string): void => {
    const S = lyricsSettings;
    lyrics.failures++;
    const delayS = Math.min(S.backoffMaxS, S.backoffBaseS * 2 ** (lyrics.failures - 1));
    backingOff = true;
    lyrics.listening = false;
    lyrics.retryAt = performance.now() + delayS * 1000;
    window.clearTimeout(idleTimer);
    window.clearTimeout(retryTimer);
    state(`paused: ${why} · retry in ${delayS}s (attempt ${lyrics.failures})`);
    retryTimer = window.setTimeout(() => {
      backingOff = false;
      lyrics.retryAt = 0;
      if (!wantListening || !lyrics.enabled) return;
      lastResultAt = performance.now();
      safeStart();
      state('listening again');
    }, delayS * 1000);
  };

  /** Ticks while listening (≤ 5 s, so slider changes take effect promptly)
   *  and backs off once nothing has been heard for idleTimeoutS. */
  const armIdle = (): void => {
    window.clearTimeout(idleTimer);
    const remaining = lyricsSettings.idleTimeoutS * 1000 - (performance.now() - lastResultAt);
    idleTimer = window.setTimeout(() => {
      if (!wantListening || !lyrics.enabled || backingOff) return;
      if (performance.now() - lastResultAt >= lyricsSettings.idleTimeoutS * 1000) {
        enterBackoff(`nothing heard for ${lyricsSettings.idleTimeoutS}s`);
        try { rec?.abort(); } catch { /* ignore */ }
      } else {
        armIdle();
      }
    }, Math.max(250, Math.min(5000, remaining)));
  };

  /** Returns the cleaned phrase, or a rejection reason prefixed with '!'. */
  const gate = (transcript: string, confidence: number): string => {
    const S = lyricsSettings;
    const words = transcript.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '!empty';
    if (words.length > S.maxWords) return `!${words.length} words > max ${S.maxWords}`;
    for (const word of words) {
      if (!/^[a-z][a-z']*$/.test(word)) return `!non-word "${word}"`;
      if (word.length < S.minWordLen && !STOP.has(word)) return `!short word "${word}"`;
    }
    const content = words.filter((x) => !STOP.has(x));
    const ratio = content.length / words.length;
    if (S.minContentRatio > 0 && content.length === 0) return '!all filler';
    if (ratio < S.minContentRatio) return `!filler: ${content.length}/${words.length} content < ${S.minContentRatio.toFixed(2)}`;
    const floor = words.length <= 2 ? S.minConfidenceShort : S.minConfidence;
    if (!(confidence >= floor)) return `!confidence ${confidence.toFixed(2)} < ${floor.toFixed(2)}`;
    return words.join(' ');
  };

  const build = (): Recognition => {
    const r = new Ctor();
    r.lang = navigator.language || 'en-US';
    r.continuous = true;
    // Interim results feed the debug panel only; nothing is shown from them.
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const alt = res[0];
        if (!res.isFinal) {
          push({ kind: 'interim', transcript: alt.transcript.trim(), confidence: 0, accepted: false, reason: '' });
          continue;
        }
        // Any final result means the service is hearing words: reset the backoff.
        lastResultAt = performance.now();
        lyrics.failures = 0;
        const verdict = gate(alt.transcript, alt.confidence);
        const accepted = !verdict.startsWith('!');
        push({
          kind: 'final',
          transcript: alt.transcript.trim(),
          confidence: alt.confidence,
          accepted,
          reason: accepted ? '' : verdict.slice(1),
        });
        if (accepted) {
          lyrics.recent.push({ text: verdict, at: performance.now(), confidence: alt.confidence });
          if (lyrics.recent.length > 8) lyrics.recent.shift();
          onPhrase(verdict, alt.confidence);
        }
      }
    };
    r.onerror = (e) => {
      lyrics.lastError = e.error;
      // 'no-speech' and 'aborted' are routine; 'not-allowed' means stop
      // trying; 'network' is Chrome dropping the stream — back off and retry.
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        push({ kind: 'error', transcript: e.error, confidence: 0, accepted: false, reason: '' });
      }
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        wantListening = false;
        lyrics.listening = false;
        window.clearTimeout(idleTimer);
      } else if (e.error === 'network' && wantListening && lyrics.enabled && !backingOff) {
        enterBackoff('network error');
      }
    };
    r.onend = () => {
      lyrics.listening = false;
      // Chrome ends continuous sessions periodically; come straight back
      // (unless we are deliberately paused — the retry timer handles that).
      if (wantListening && lyrics.enabled && !backingOff) {
        setTimeout(() => { if (wantListening && lyrics.enabled && !backingOff) safeStart(); }, 300);
      }
    };
    return r;
  };

  const safeStart = (): void => {
    if (!rec) rec = build();
    try {
      rec.start();
      lyrics.listening = true;
    } catch {
      // already started — fine
      lyrics.listening = true;
    }
    armIdle();
  };

  /** Forget any backoff in progress (an explicit start/stop resets the clock). */
  const resetBackoff = (): void => {
    window.clearTimeout(idleTimer);
    window.clearTimeout(retryTimer);
    backingOff = false;
    lyrics.retryAt = 0;
    lyrics.failures = 0;
  };

  lyrics.start = () => {
    wantListening = true;
    if (lyrics.enabled) {
      resetBackoff();
      lastResultAt = performance.now();
      safeStart();
      state('listening');
    }
  };
  lyrics.stop = () => {
    wantListening = false;
    lyrics.listening = false;
    resetBackoff();
    try { rec?.abort(); } catch { /* ignore */ }
    state('stopped');
  };
  return lyrics;
}
