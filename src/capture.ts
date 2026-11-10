import { createWorker, type Worker } from 'tesseract.js';
import type { Application, CaptureEvent, Evidence, Workspace } from '../shared/types';

export interface CaptureStatus {
  state: 'starting' | 'capturing' | 'stopped' | 'error';
  message: string;
  lastCheckedAt: string | null;
}
export interface CaptureOptions {
  getApplications: () => Application[];
  workspace?: Workspace;
  onStatus?: (status: CaptureStatus) => void;
  onEvent?: (result: { application: Application; evidence: Evidence }) => void;
  onError?: (message: string) => void;
}
export interface CaptureController {
  stop: () => Promise<void>;
  activate: () => void;
  captureNow: () => Promise<void>;
}

const SUCCESS = [
  /your application (?:has been |was )?(?:successfully )?(?:submitted|received)/i,
  /we(?:'ve| have) received your application/i,
  /thank you for (?:your application|applying)/i,
  /application submitted successfully/i,
];
const FAILURE = /(?:application|submission)[^.!\n]{0,45}(?:failed|not (?:been )?submitted|could not be submitted)|unable to submit (?:your )?application/i;
const CONDITIONAL = /\b(?:if|once|when|after|until|unless|before|whether)\b[^.!?\n]{0,120}(?:your application|we(?:'ve| have) received|thank you for applying|application submitted)/i;
const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Pure matching logic: never identify a role by company alone. */
export function matchVisualConfirmation(text: string, applications: Application[]) {
  if (FAILURE.test(text) || CONDITIONAL.test(text)) return null;
  const match = SUCCESS.map(pattern => text.match(pattern)).find(Boolean);
  if (!match) return null;
  const normalized = ` ${normalize(text)} `;
  const candidates = applications.filter(application => {
    const company = normalize(application.company);
    const role = normalize(application.role);
    return company.length >= 2 && role.length >= 4 &&
      normalized.includes(` ${company} `) && normalized.includes(` ${role} `);
  });
  if (candidates.length !== 1) return { application: null, phrase: match[0] };
  return { application: candidates[0], phrase: match[0] };
}

/** Captures only a surface chosen through the browser's permission dialog. */
export async function startCapture(options: CaptureOptions): Promise<CaptureController> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('Screen capture is unavailable in this browser. Open Apply in Chrome or Edge on this computer.');
  }
  options.onStatus?.({ state: 'starting', message: 'Choose the application tab or window.', lastCheckedAt: null });
  // Invoke before any network or OCR initialization to preserve user activation.
  const captureOptions: DisplayMediaStreamOptions & { selfBrowserSurface: 'exclude' } = {
    video: { frameRate: 2 }, audio: false, selfBrowserSurface: 'exclude',
  };
  const stream = await navigator.mediaDevices.getDisplayMedia(captureOptions);
  let stopped = false;
  let active = false;
  let running = false;
  let lastCheckedAt: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let worker: Worker | null = null;
  let failedChecks = 0;
  const lifecycle = new AbortController();
  const sent = new Set<string>();
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  const canvas = document.createElement('canvas');
  const status = (message: string, state: CaptureStatus['state'] = 'capturing') => {
    options.onStatus?.({ state, message, lastCheckedAt });
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    active = false;
    lifecycle.abort();
    clearTimeout(timer);
    stream.getTracks().forEach(track => track.stop());
    video.pause();
    video.srcObject = null;
    canvas.width = 0;
    canvas.height = 0;
    const activeWorker = worker;
    worker = null;
    if (activeWorker) await activeWorker.terminate().catch(() => undefined);
    status('Screen capture stopped.', 'stopped');
  };
  stream.getVideoTracks()[0]?.addEventListener('ended', () => { void stop(); }, { once: true });

  const captureNow = async () => {
    if (stopped || !active || running || !worker || video.readyState < 2) return;
    clearTimeout(timer);
    running = true;
    try {
      // A stopped server session also stops the browser media stream.
      const sessionResponse = await fetch('/api/sessions/current');
      if (!sessionResponse.ok) throw new Error('The local tracker is unavailable.');
      const { session } = await sessionResponse.json();
      if (!session || session.stoppedAt || !session.screenEnabled) {
        await stop();
        return;
      }
      const scale = Math.min(1, 1800 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context || !canvas.width || !canvas.height) return;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const result = await worker.recognize(canvas);
      if (stopped) return;
      lastCheckedAt = new Date().toISOString();
      failedChecks = 0;
      const finding = matchVisualConfirmation(result.data.text, options.getApplications());
      if (!finding) {
        status('Checking the selected screen.');
        return;
      }
      if (!finding.application) {
        status('Confirmation seen. Add the matching job to link this evidence.');
        return;
      }
      const application = finding.application;
      const sourceId = `visual:${session.id}:${application.id}:submission`;
      if (sent.has(sourceId)) {
        status('Confirmation already recorded.');
        return;
      }
      const requiresReview = result.data.confidence < 85;
      const event: CaptureEvent = {
        applicationId: application.id,
        workspace: options.workspace ?? application.workspace,
        source: 'visual', kind: 'submission_confirmed',
        company: application.company, role: application.role,
        summary: 'Submission confirmation seen on screen',
        excerpt: finding.phrase,
        observedAt: lastCheckedAt, sourceId, requiresReview,
        snapshot: canvas.toDataURL('image/jpeg', 0.65),
      };
      const response = await fetch('/api/events', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || 'Could not save screen evidence.');
      }
      const saved = await response.json();
      sent.add(sourceId);
      options.onEvent?.(saved);
      status(requiresReview ? 'Screen evidence saved for review.' : 'Screen confirmation saved.');
    } catch (error) {
      if (stopped) return;
      failedChecks += 1;
      const message = error instanceof Error ? error.message : 'Screen analysis failed.';
      options.onError?.(message);
      status(message, 'error');
      if (failedChecks >= 3) await stop();
    } finally {
      running = false;
      // Independent interval: this does not depend on extension click detection.
      if (!stopped && active) timer = setTimeout(() => { void captureNow(); }, 12_000);
    }
  };

  try {
    await video.play();
    if (stopped) throw new Error('Screen sharing stopped before checks were ready.');
    status('Loading on-device text recognition.', 'starting');
    // Tesseract downloads its worker/core and English language assets on first use.
    // Recognition happens inside the browser. Images are never uploaded to its CDN.
    let rejectInitialization: (reason: Error) => void = () => undefined;
    const failure = new Promise<never>((_resolve, reject) => { rejectInitialization = reject; });
    const cancelled = () => rejectInitialization(new Error('Screen sharing stopped before checks were ready.'));
    lifecycle.signal.addEventListener('abort', cancelled, { once: true });
    const loading = createWorker('eng', 1, {
      errorHandler: () => rejectInitialization(new Error('Text recognition could not load. Check your connection and try again.')),
    });
    let initializationFailed = false;
    void loading.then(created => {
      if (stopped || initializationFailed) void created.terminate();
    }).catch(() => undefined);
    const initializationTimer = setTimeout(() => {
      rejectInitialization(new Error('Text recognition took too long to load. Check your connection and try again.'));
    }, 60_000);
    let createdWorker: Worker;
    try {
      createdWorker = await Promise.race([loading, failure]);
    } catch (error) {
      initializationFailed = true;
      throw error;
    } finally {
      clearTimeout(initializationTimer);
      lifecycle.signal.removeEventListener('abort', cancelled);
    }
    if (stopped) throw new Error('Screen sharing stopped before checks were ready.');
    worker = createdWorker;
    status('Screen selected. Ready to start checks.', 'starting');
    const activate = () => {
      if (stopped) throw new Error('Screen sharing has stopped. Choose a screen again.');
      if (active) return;
      active = true;
      status('Screen capture is on. Checking every 12 seconds.');
      void captureNow();
    };
    return { stop, activate, captureNow };
  } catch (error) {
    await stop();
    throw new Error(error instanceof Error ? error.message : 'Screen capture could not start.');
  }
}
