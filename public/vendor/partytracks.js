/*! PartyTracks 0.0.56, Copyright 2024 Sunil Pai, ISC; see licenses/PartyTracks-ISC.txt. SimpleShare negotiation fixes. */
import { requestMedia } from '../lib/media-request.js';
import { runSessionMutation, closeSessionTracks } from '../lib/media-session.js';
import {
  BehaviorSubject,
  Observable,
  ReplaySubject,
  Subject,
  catchError,
  combineLatest,
  concat,
  defer,
  distinctUntilChanged,
  filter,
  forkJoin,
  from,
  fromEvent,
  map,
  merge,
  of,
  share,
  shareReplay,
  skip,
  switchMap,
  take,
  tap,
  throwError,
  timer,
  withLatestFrom,
} from 'rxjs';
import invariant from 'tiny-invariant';
import { retry } from 'rxjs/operators';
import { innerFrom } from 'rxjs/internal/observable/innerFrom';
import { createOperatorSubscriber } from 'rxjs/internal/operators/OperatorSubscriber';
//#region src/client/History.ts
var History = class extends EventTarget {
  entries = [];
  limit;
  constructor(limit = Number.POSITIVE_INFINITY) {
    super();
    this.limit = Math.max(1, limit);
  }
  addEventListener(type, callback, options) {
    super.addEventListener(type, callback, options);
  }
  removeEventListener(type, callback, options) {
    super.removeEventListener(type, callback, options);
  }
  log(entry) {
    if (this.entries.length >= this.limit) this.entries.shift();
    this.entries.push(entry);
    this.dispatchEvent(new CustomEvent('logentry'));
  }
};
//#endregion
//#region src/client/logging.ts
const logLevels = ['none', 'error', 'warn', 'info', 'debug'];
const levelRef = { current: 'warn' };
const setLogLevel = (newLogLevel) => {
  levelRef.current = newLogLevel;
};
const logger = {
  error: (...data) => {
    if (logLevels.indexOf(levelRef.current) >= logLevels.indexOf('error')) console.error(...data);
  },
  warn: (...data) => {
    if (logLevels.indexOf(levelRef.current) >= logLevels.indexOf('warn')) console.warn(...data);
  },
  info: (...data) => {
    if (logLevels.indexOf(levelRef.current) >= logLevels.indexOf('info')) console.info(...data);
  },
  log: (...data) => {
    if (logLevels.indexOf(levelRef.current) >= logLevels.indexOf('info')) console.log(...data);
  },
  debug: (...data) => {
    if (logLevels.indexOf(levelRef.current) >= logLevels.indexOf('debug')) console.debug(...data);
  },
};
//#endregion
//#region src/client/Peer.utils.ts
const DefaultBatchSizeLimit = 64;
var FIFOScheduler = class {
  #schedulerChain;
  constructor() {
    this.#schedulerChain = Promise.resolve();
  }
  schedule(task) {
    return new Promise((resolve, reject) => {
      this.#schedulerChain = this.#schedulerChain.then(async () => {
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        }
      });
    });
  }
};
var BulkRequestDispatcher = class {
  #currentBatch;
  #currentBulkResponse;
  #batchSizeLimit;
  constructor(batchSizeLimit = DefaultBatchSizeLimit) {
    this.#currentBatch = [];
    this.#currentBulkResponse = null;
    this.#batchSizeLimit = batchSizeLimit;
  }
  doBulkRequest(params, bulkRequestFunc) {
    if (this.#currentBatch.length >= this.#batchSizeLimit) {
      this.#currentBatch = [];
      this.#currentBulkResponse = null;
    }
    this.#currentBatch.push(params);
    if (this.#currentBulkResponse != null) return this.#currentBulkResponse;
    const batch = this.#currentBatch;
    this.#currentBulkResponse = new Promise((resolve, reject) => {
      setTimeout(() => {
        this.#currentBulkResponse = null;
        bulkRequestFunc(batch.splice(0, batch.length))
          .then((r) => {
            resolve(r);
          })
          .catch((err) => {
            reject(err);
          });
      }, 0);
    });
    return this.#currentBulkResponse;
  }
};
//#endregion
//#region src/client/rxjs-helpers.ts
const configDefaults = {
  maxRetries: Number.POSITIVE_INFINITY,
  initialDelay: 250,
  maxDelay: 1e4,
  backoffFactor: 2,
  resetOnSuccess: true,
};
function retryWithBackoff(config = {}) {
  const {
    maxRetries = Number.POSITIVE_INFINITY,
    initialDelay = 250,
    maxDelay = 1e4,
    backoffFactor = 2,
    resetOnSuccess = true,
  } = {
    ...configDefaults,
    ...config,
  };
  return (source) =>
    source.pipe(
      retry({
        count: maxRetries,
        resetOnSuccess,
        delay: (err, count) => {
          if (err?.retryable === false) return throwError(() => err);
          return timer(Math.min(initialDelay * backoffFactor ** (count - 1), maxDelay));
        },
      }),
    );
}
//#endregion
//#region src/client/fromFetch.ts
/**
 * Slightly modified version of rxjs fromFetch that
 * allows providing the fetcher function.
 */
function fromFetch(input, initWithSelector = {}) {
  const { selector, fetchImpl = fetch, ...init } = initWithSelector;
  return new Observable((subscriber) => {
    const controller = new AbortController();
    const { signal } = controller;
    let abortable = true;
    const { signal: outerSignal } = init;
    if (outerSignal)
      if (outerSignal.aborted) controller.abort();
      else {
        const outerSignalHandler = () => {
          if (!signal.aborted) controller.abort();
        };
        outerSignal.addEventListener('abort', outerSignalHandler);
        subscriber.add(() => outerSignal.removeEventListener('abort', outerSignalHandler));
      }
    const perSubscriberInit = {
      ...init,
      signal,
    };
    const handleError = (err) => {
      abortable = false;
      subscriber.error(err);
    };
    fetchImpl(input, perSubscriberInit)
      .then((response) => {
        if (selector)
          innerFrom(selector(response)).subscribe(
            createOperatorSubscriber(
              subscriber,
              void 0,
              () => {
                abortable = false;
                subscriber.complete();
              },
              handleError,
            ),
          );
        else {
          abortable = false;
          subscriber.next(response);
          subscriber.complete();
        }
      })
      .catch(handleError);
    return () => {
      if (abortable) controller.abort();
    };
  });
}
//#endregion
//#region src/client/PartyTracks.ts
var PartyTracks = class {
  /**
	Useful for logging/debugging purposes.
	*/
  history;
  /**
	An observable of the active peerConnection. If the active peerConnection
	is disrupted, a new one will be created and emitted
	*/
  peerConnection$;
  /**
	An observable of the active peerConnection and its associated sessionId.
	This flows from the peerConnection$, and will emit with the new peerConnection
	and a new sessionId when the peerConnection changes.
	*/
  session$;
  #transceiver$ = new ReplaySubject(32);
  /**
	Emits transceivers each time they are added  to the peerConnection.
	*/
  transceiver$ = this.#transceiver$.asObservable();
  sessionError$;
  /**
	An observable of the peerConnection's connectionState.
	*/
  peerConnectionState$;
  #config;
  #params;
  constructor(config = {}) {
    this.#config = {
      prefix: '/partytracks',
      maxApiHistory: 100,
      ...config,
    };
    this.#params = new URLSearchParams(config.apiExtraParams);
    this.history = new History(this.#config.maxApiHistory);
    this.session$ = makePeerConnectionSessionCombo({
      fetch: (input, init) => this.#fetchWithRecordedHistory(input, init),
      params: this.#params,
      iceServers: this.#config.iceServers,
      onSessionClosed: this.#config.onSessionClosed,
      prefix: this.#config.prefix ?? '/partytracks',
    });
    this.peerConnection$ = this.session$.pipe(map(({ peerConnection }) => peerConnection));
    this.sessionError$ = this.session$.pipe(
      catchError((err) => of(err instanceof Error ? err.message : 'Caught non-error')),
      filter((value) => typeof value === 'string'),
    );
    this.peerConnectionState$ = this.peerConnection$.pipe(
      switchMap((peerConnection) =>
        fromEvent(peerConnection, 'connectionstatechange', () => peerConnection.connectionState),
      ),
      shareReplay({
        refCount: true,
        bufferSize: 1,
      }),
    );
  }
  #taskScheduler = new FIFOScheduler();
  #pushTrackDispatcher = new BulkRequestDispatcher(32);
  #pullTrackDispatcher = new BulkRequestDispatcher(32);
  #closeTrackDispatcher = new BulkRequestDispatcher(32);
  async #fetchWithRecordedHistory(path, requestInit) {
    this.history.log({
      endpoint: path.toString(),
      method: requestInit?.method ?? 'get',
      type: 'request',
      body: typeof requestInit?.body === 'string' ? JSON.parse(requestInit.body) : void 0,
    });
    const headers = new Headers(requestInit?.headers);
    const additionalHeaders = this.#config.headers;
    if (additionalHeaders)
      additionalHeaders.forEach((value, key) => {
        headers.append(key, value);
      });
    const { response, body: responseBody } = await requestMedia(
      path,
      {
        ...requestInit,
        headers,
        redirect: 'manual',
      },
      { timeout: this.#config.requestTimeout ?? 12000 },
    );
    this.history.log({
      endpoint: path.toString(),
      type: 'response',
      body: responseBody,
    });
    return response;
  }
  #pushTrackInBulk(peerConnection, transceiver, sessionId, trackName) {
    return new Observable((subscriber) => {
      logger.debug('📤 pushing track ', trackName);
      this.#pushTrackDispatcher
        .doBulkRequest(
          {
            trackName,
            transceiver,
          },
          (tracks) =>
            this.#taskScheduler.schedule(() =>
              runSessionMutation(peerConnection, async () => {
                const offer = await peerConnection.createOffer();
                await peerConnection.setLocalDescription(offer);
                const requestBody = {
                  sessionDescription: {
                    sdp: offer.sdp,
                    type: 'offer',
                  },
                  tracks: tracks.map(({ trackName, transceiver }) => ({
                    trackName,
                    mid: transceiver.mid,
                    location: 'local',
                  })),
                };
                const response = await this.#fetchWithRecordedHistory(
                  `${this.#config.prefix}/sessions/${sessionId}/tracks/new?${this.#params}`,
                  {
                    method: 'POST',
                    body: JSON.stringify(requestBody),
                  },
                ).then((res) => res.json());
                if (response.errorCode)
                  throw new Error(response.errorDescription || response.errorCode);
                invariant(response.tracks !== void 0);
                if (!response.errorCode) {
                  await peerConnection.setRemoteDescription(
                    new RTCSessionDescription(response.sessionDescription),
                  );
                  await signalingStateIsStable(peerConnection);
                }
                return { tracks: response.tracks };
              }),
            ),
        )
        .then(({ tracks }) => {
          const trackData = tracks.find((t) => t.mid === transceiver.mid);
          if (trackData) {
            const cancelWait = waitForTransceiverToSendData(transceiver, () => {
              subscriber.next({
                ...trackData,
                sessionId,
                location: 'remote',
              });
            });
            subscriber.add(() => {
              cancelWait();
              if (transceiver.mid) {
                logger.debug('🔚 Closing pushed track ', trackName);
                this.#closeTrackInBulk(peerConnection, transceiver.mid, sessionId);
              }
            });
          } else subscriber.error(/* @__PURE__ */ new Error('Missing TrackData'));
        })
        .catch((err) => subscriber.error(err));
    }).pipe(retryWithBackoff());
  }
  /**
	Pushes a track to the Realtime SFU. If the sourceTrack$ emits a new
	track after the initial one, the new track will replace the old one
	on the transceiver. Same with sendEncodings$, the initial values will
	be applied, and subsequent emissions will be applied.
	
	Additionally, if the peerConnection is disrupted and session$ emits
	a new peerConnection/sessionId combo, the track will be re-pushed,
	and will emit new TrackMetadata
	*/
  push(sourceTrack$, options = {}) {
    const track$ = sourceTrack$.pipe(
      shareReplay({
        refCount: true,
        bufferSize: 1,
      }),
    );
    const sendEncodings$ = (options.sendEncodings$ ?? of([])).pipe(
      shareReplay({
        refCount: true,
        bufferSize: 1,
      }),
    );
    const transceiver$ = combineLatest([
      track$.pipe(
        take(1),
        map(() => crypto.randomUUID()),
      ),
      this.session$,
    ]).pipe(
      withLatestFrom(track$),
      withLatestFrom(sendEncodings$),
      map(([[[stableId, session], track], sendEncodings]) => {
        const transceiver = session.peerConnection.addTransceiver(track, {
          direction: 'sendonly',
          sendEncodings,
        });
        logger.debug('🌱 creating transceiver!');
        this.#transceiver$.next(transceiver);
        return {
          transceiver,
          stableId,
          session,
        };
      }),
      shareReplay({
        refCount: true,
        bufferSize: 1,
      }),
    );
    return combineLatest([
      transceiver$.pipe(
        switchMap(({ session: { peerConnection, sessionId }, transceiver, stableId }) =>
          this.#pushTrackInBulk(peerConnection, transceiver, sessionId, stableId),
        ),
      ),
      transceiver$,
      track$,
      concat(of(void 0), sendEncodings$.pipe(skip(1))),
    ]).pipe(
      filter(([trackData, { session }]) => trackData.sessionId === session.sessionId),
      tap(([_trackData, { transceiver }, track, sendEncodings]) => {
        if (transceiver.sender.transport !== null) {
          logger.debug('♻︎ replacing track');
          transceiver.sender.replaceTrack(track);
        }
        if (sendEncodings) {
          const parameters = transceiver.sender.getParameters();
          transceiver.sender.setParameters({
            ...parameters,
            encodings: sendEncodings,
          });
        }
      }),
      map(([trackData]) => {
        const cleanedTrackData = { ...trackData };
        delete cleanedTrackData.mid;
        return cleanedTrackData;
      }),
      shareReplay({
        refCount: true,
        bufferSize: 1,
      }),
    );
  }
  #pullTrackInBulk(peerConnection, sessionId, trackMetadata) {
    trackMetadata = { ...trackMetadata };
    return new Observable((subscriber) => {
      logger.debug('📥 pulling track ', trackMetadata.trackName);
      this.#pullTrackDispatcher
        .doBulkRequest(trackMetadata, (tracks) =>
          this.#taskScheduler.schedule(() =>
            runSessionMutation(peerConnection, async () => {
              const newTrackResponse = await this.#fetchWithRecordedHistory(
                `${this.#config.prefix}/sessions/${sessionId}/tracks/new?${this.#params}`,
                {
                  method: 'POST',
                  body: JSON.stringify({ tracks }),
                },
              ).then((res) => res.json());
              if (newTrackResponse.errorCode) throw new Error(newTrackResponse.errorDescription);
              invariant(newTrackResponse.tracks);
              const trackMap = tracks.reduce((acc, track) => {
                const pulledTrackData = newTrackResponse.tracks?.find(
                  (t) => t.trackName === track.trackName && t.sessionId === track.sessionId,
                );
                if (pulledTrackData?.mid)
                  acc.set(track, {
                    mid: pulledTrackData.mid,
                    resolvedTrack: resolveTransceiver(
                      peerConnection,
                      (t) => t.mid === pulledTrackData.mid,
                    ).then((transceiver) => {
                      this.#transceiver$.next(transceiver);
                      return transceiver.receiver.track;
                    }),
                  });
                return acc;
              }, /* @__PURE__ */ new Map());
              if (newTrackResponse.requiresImmediateRenegotiation) {
                await peerConnection.setRemoteDescription(
                  new RTCSessionDescription(newTrackResponse.sessionDescription),
                );
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                const renegotiationResponse = await this.#fetchWithRecordedHistory(
                  `${this.#config.prefix}/sessions/${sessionId}/renegotiate?${this.#params}`,
                  {
                    method: 'PUT',
                    body: JSON.stringify({
                      sessionDescription: {
                        type: 'answer',
                        sdp: peerConnection.currentLocalDescription?.sdp,
                      },
                    }),
                  },
                ).then((res) => res.json());
                if (renegotiationResponse.errorCode)
                  throw new Error(renegotiationResponse.errorDescription);
                else await signalingStateIsStable(peerConnection);
              }
              return { trackMap };
            }),
          ),
        )
        .then(({ trackMap }) => {
          const trackInfo = trackMap.get(trackMetadata);
          if (trackInfo)
            trackInfo.resolvedTrack
              .then((track) => {
                subscriber.next({
                  track,
                  trackMetadata,
                });
                subscriber.add(() => {
                  logger.debug('🔚 Closing pulled track ', trackMetadata.trackName, peerConnection);
                  this.#closeTrackInBulk(peerConnection, trackInfo.mid, sessionId);
                });
              })
              .catch((err) => subscriber.error(err));
          else subscriber.error(/* @__PURE__ */ new Error('Missing Track Info'));
          return trackMetadata.trackName;
        })
        .catch((err) => subscriber.error(err));
    }).pipe(retryWithBackoff());
  }
  /**
	Pulls a track from the Realtime SFU. If trackData$ emits new TrackMetadata
	or if the peerConnection is disrupted and session$ emits a new
	peerConnection/sessionId combo, the track will be re-pulled, and will emit
	a new MediaStreamTrack.
	*/
  pull(trackData$, options = {}) {
    const preferredRid$ = options.simulcast?.preferredRid$ ?? of(void 0);
    const pulledTrack$ = combineLatest([
      this.session$,
      trackData$.pipe(distinctUntilChanged((x, y) => JSON.stringify(x) === JSON.stringify(y))),
    ]).pipe(
      withLatestFrom(preferredRid$),
      switchMap(([[{ peerConnection, sessionId }, trackData], preferredRid]) => {
        return this.#pullTrackInBulk(
          peerConnection,
          sessionId,
          preferredRid
            ? {
                ...trackData,
                simulcast: { preferredRid },
              }
            : trackData,
        );
      }),
    );
    const subsequentPreferredRid$ = concat(of(void 0), preferredRid$.pipe(skip(1)));
    return combineLatest([pulledTrack$, this.session$, subsequentPreferredRid$]).pipe(
      tap(([{ track, trackMetadata }, { peerConnection, sessionId }, preferredRid]) => {
        if (preferredRid === void 0) return;
        logger.log(
          `🔧 Updating preferredRid (${preferredRid}) for trackName ${trackMetadata.trackName}`,
        );
        const transceiver = peerConnection
          .getTransceivers()
          .find((t) => t.receiver.track === track);
        if (!transceiver) return;
        const request = {
          tracks: [
            {
              ...trackMetadata,
              mid: transceiver.mid,
              simulcast: { preferredRid },
            },
          ],
        };
        this.#fetchWithRecordedHistory(
          `${this.#config.prefix}/sessions/${sessionId}/tracks/update?${this.#params}`,
          {
            method: 'PUT',
            body: JSON.stringify(request),
          },
        );
      }),
      map(([{ track }]) => track),
      shareReplay({
        refCount: true,
        bufferSize: 1,
      }),
    );
  }
  async #closeTrackInBulk(peerConnection, mid, sessionId) {
    const transceiver = peerConnection.getTransceivers().find((t) => t.mid === mid);
    if (peerConnection.connectionState !== 'connected' || transceiver === void 0) {
      logger.log('Bailing a closing track because connection is closed');
      return;
    }
    this.#closeTrackDispatcher
      .doBulkRequest({ mid }, (mids) =>
        this.#taskScheduler.schedule(() =>
          runSessionMutation(peerConnection, async () => {
            if (peerConnection.connectionState === 'closed') {
              logger.log('Bailing a closing track because connection is closed');
              return;
            }
            await closeSessionTracks(peerConnection, mids, (requestBody) =>
              this.#fetchWithRecordedHistory(
                `${this.#config.prefix}/sessions/${sessionId}/tracks/close?${this.#params}`,
                {
                  method: 'PUT',
                  body: JSON.stringify(requestBody),
                },
              ).then((res) => res.json()),
            );
          }),
        ),
      )
      .catch((err) => logger.error('Track cleanup failed; media session retired', err));
  }
};
async function resolveTransceiver(peerConnection, compare, timeout = 5e3) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      peerConnection.removeEventListener('track', handler);
      reject(new Error('Timed out waiting for remote track'));
    }, timeout);
    const handler = () => {
      const transceiver = peerConnection.getTransceivers().find(compare);
      if (transceiver) {
        clearTimeout(timer);
        resolve(transceiver);
        peerConnection.removeEventListener('track', handler);
      }
    };
    peerConnection.addEventListener('track', handler);
    handler();
  });
}
function waitForTransceiverToSendData(transceiver, onDataSent) {
  let delay = 1;
  let _checks = 0;
  const maxDelay = 100;
  let timeoutId;
  let cancelled = false;
  const checkStats = async () => {
    if (cancelled) return;
    _checks++;
    try {
      const stats = await transceiver.sender.getStats();
      let dataFound = false;
      stats.forEach((stat) => {
        if (stat.type === 'outbound-rtp' && stat.bytesSent > 0) dataFound = true;
      });
      if (dataFound && !cancelled) {
        onDataSent();
        return;
      } else if (dataFound) return;
    } catch (_error) {}
    delay = Math.min(delay * 1.1, maxDelay);
    timeoutId = window.setTimeout(checkStats, delay);
  };
  checkStats();
  return () => {
    cancelled = true;
    if (timeoutId !== void 0) clearTimeout(timeoutId);
  };
}
async function signalingStateIsStable(peerConnection) {
  if (peerConnection.signalingState !== 'stable')
    await new Promise((res, rej) => {
      const timeout = setTimeout(() => {
        peerConnection.removeEventListener('signalingstatechange', signalingStateChangeHandler);
        rej(/* @__PURE__ */ new Error('Signaling State did not stabilize within 5 seconds'));
      }, 5e3);
      const signalingStateChangeHandler = () => {
        if (peerConnection.signalingState === 'stable') {
          peerConnection.removeEventListener('signalingstatechange', signalingStateChangeHandler);
          clearTimeout(timeout);
          res(void 0);
        }
      };
      peerConnection.addEventListener('signalingstatechange', signalingStateChangeHandler);
    });
}
function makePeerConnectionSessionCombo(options) {
  return forkJoin({
    sessionId: fromFetch(`${options.prefix}/sessions/new?${options.params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      fetchImpl: options.fetch,
      selector: (res) =>
        res.json().then((body) => {
          if (!body.sessionId) throw new Error('Media service returned no session ID');
          return body.sessionId;
        }),
    }),
    iceServers: options.iceServers
      ? of(options.iceServers)
      : fromFetch(`${options.prefix}/generate-ice-servers`, {
          fetchImpl: options.fetch,
          selector: (res) =>
            res.json().then((body) => {
              if (!Array.isArray(body.iceServers))
                throw new Error('Media service returned no ICE servers');
              return body.iceServers;
            }),
        }),
  }).pipe(
    switchMap(
      ({ sessionId, iceServers }) =>
        new Observable((subscriber) => {
          let iceTimeout = -1;
          const peerConnection = new RTCPeerConnection({
            iceServers,
            bundlePolicy: 'max-bundle',
          });
          const reconnect = (message) => {
            logger.log(`💥 ${message}`);
            subscriber.error(new Error(message));
          };
          subscriber.add(() => {
            clearTimeout(iceTimeout);
            peerConnection.close();
            try {
              options.onSessionClosed?.(sessionId);
            } catch (error) {
              logger.warn('Media cleanup callback failed', error);
            }
          });
          peerConnection.addEventListener('connectionstatechange', () => {
            logger.log('PeerConnection connectionstatechange: ', peerConnection.connectionState);
            if (
              peerConnection.connectionState === 'failed' ||
              peerConnection.connectionState === 'closed'
            )
              reconnect(`PeerConnection connectionState ${peerConnection.connectionState}`);
          });
          peerConnection.addEventListener('iceconnectionstatechange', () => {
            logger.log(
              'PeerConnection iceconnectionstatechange: ',
              peerConnection.iceConnectionState,
            );
            clearTimeout(iceTimeout);
            if (
              peerConnection.iceConnectionState === 'failed' ||
              peerConnection.iceConnectionState === 'closed'
            )
              reconnect(`💥 Peer iceConnectionState is ${peerConnection.iceConnectionState}`);
            else if (peerConnection.iceConnectionState === 'disconnected') {
              const timeoutSeconds = 7;
              iceTimeout = window.setTimeout(() => {
                if (peerConnection.iceConnectionState === 'connected') return;
                reconnect(
                  `💥 Peer iceConnectionState was ${peerConnection.iceConnectionState} for more than ${timeoutSeconds} seconds`,
                );
              }, timeoutSeconds * 1e3);
            }
          });
          subscriber.next({
            peerConnection,
            sessionId,
          });
        }),
    ),
    retryWithBackoff({ backoffFactor: 1.1 }),
    shareReplay({
      refCount: true,
      bufferSize: 1,
    }),
  );
}
//#endregion
//#region src/client/trackIsHealthy.ts
async function trackIsHealthy(track) {
  logger.info('👩🏻‍⚕️ Checking track health...');
  if (track.enabled) {
  }
  const randomFailure =
    localStorage.getItem('flags.randomTrackFailuresEnabled') === 'true' && Math.random() < 0.2;
  if (randomFailure) logger.info('🎲 Random track failure!');
  const healthy = !track.muted && track.readyState === 'live' && !randomFailure;
  try {
    if (!healthy) {
      const deviceFromTrack = (await navigator.mediaDevices.enumerateDevices()).find(
        (device) => device.deviceId === track.getSettings().deviceId,
      );
      logger.info(
        `👩🏻‍⚕️ Track from ${deviceFromTrack?.label ?? "unkonwn device (enumerateDevices didn't find a matching device id)"} is unhealthy!`,
      );
      logger.info(
        `👩🏻‍⚕️ track.readyState: ${track.readyState} and track.muted: ${track.muted}`,
        track,
      );
    }
  } catch (e) {
    logger.error('Error getting device info for unhealthy track', e, track);
  }
  logger.info(`👩🏻‍⚕️ track is ${healthy ? 'healthy' : 'unhealthy'}!`);
  return healthy;
}
//#endregion
//#region src/client/resilientTrack$.ts
var DevicesExhaustedError = class extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
};
const devices$ = defer(() =>
  merge(
    from(navigator.mediaDevices.enumerateDevices()),
    fromEvent(navigator.mediaDevices, 'devicechange').pipe(
      switchMap(() => navigator.mediaDevices.enumerateDevices()),
    ),
    navigator.permissions?.query
      ? from(navigator.permissions.query({ name: 'camera' })).pipe(
          switchMap((permissionStatus) => fromEvent(permissionStatus, 'change')),
          switchMap(() => navigator.mediaDevices.enumerateDevices()),
        )
      : of([]),
    navigator.permissions?.query
      ? from(navigator.permissions.query({ name: 'microphone' })).pipe(
          switchMap((permissionStatus) => fromEvent(permissionStatus, 'change')),
          switchMap(() => navigator.mediaDevices.enumerateDevices()),
        )
      : of([]),
  ).pipe(
    distinctUntilChanged((prev, current) => JSON.stringify(prev) === JSON.stringify(current)),
    shareReplay({
      refCount: true,
      bufferSize: 1,
    }),
  ),
);
const resilientTrack$ = ({
  kind,
  constraints = {},
  devicePriority$ = devices$,
  onDeviceFailure = () => {},
  onUnconstrainedDeviceSelection = () => {},
}) =>
  devicePriority$
    .pipe(
      map((list) => list.filter((d) => d.kind === kind)),
      distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
    )
    .pipe(
      switchMap((deviceList) =>
        concat(
          ...deviceList.map(
            (device) =>
              new Observable((subscriber) => {
                acquireTrack(
                  subscriber,
                  device,
                  constraints,
                  onDeviceFailure,
                  onUnconstrainedDeviceSelection,
                );
              }),
          ),
          throwError(() => new DevicesExhaustedError()),
        ),
      ),
      share({
        resetOnComplete: true,
        resetOnError: true,
        connector: () => new ReplaySubject(1),
      }),
    );
function acquireTrack(
  subscriber,
  device,
  constraints,
  onDeviceFailure,
  onUnconstrainedDeviceSelection = () => {},
) {
  const { deviceId, groupId, label } = device;
  logger.log(`🙏🏻 Requesting ${label}`);
  navigator.mediaDevices
    .getUserMedia(
      device.kind === 'videoinput'
        ? {
            video: {
              ...constraints,
              deviceId: deviceId ? { exact: deviceId } : void 0,
              groupId: groupId ? { exact: groupId } : void 0,
            },
          }
        : {
            audio: {
              ...constraints,
              deviceId: deviceId ? { exact: deviceId } : void 0,
              groupId: groupId ? { exact: groupId } : void 0,
            },
          },
    )
    .then(async (mediaStream) => {
      const track =
        device.kind === 'videoinput'
          ? mediaStream.getVideoTracks()[0]
          : mediaStream.getAudioTracks()[0];
      if (await trackIsHealthy(track)) {
        const cleanup = () => {
          logger.log('🛑 Stopping track');
          track.stop();
          document.removeEventListener('visibilitychange', onVisibleHandler);
        };
        const onVisibleHandler = async () => {
          if (document.visibilityState !== 'visible') return;
          logger.log('Tab is foregrounded, checking health...');
          if (await trackIsHealthy(track)) return;
          logger.log('Reacquiring track');
          cleanup();
          acquireTrack(
            subscriber,
            device,
            constraints,
            onDeviceFailure,
            onUnconstrainedDeviceSelection,
          );
        };
        document.addEventListener('visibilitychange', onVisibleHandler);
        subscriber.add(cleanup);
        subscriber.next(track);
        if (!deviceId && !groupId) {
          const trackSettings = track.getSettings();
          const foundDevice = await navigator.mediaDevices
            .enumerateDevices()
            .then((devices) =>
              devices.find(
                (d) => d.deviceId === trackSettings.deviceId && d.groupId === trackSettings.groupId,
              ),
            )
            .catch(() => void 0);
          if (foundDevice) onUnconstrainedDeviceSelection(foundDevice);
        }
      } else {
        logger.log('☠️ track is not healthy, stopping');
        if (device instanceof MediaDeviceInfo) onDeviceFailure(device);
        track.stop();
        subscriber.complete();
      }
      track.addEventListener('ended', () => {
        logger.log('🔌 Track ended abrubptly');
        subscriber.complete();
      });
    })
    .catch((err) => {
      if (err instanceof Error && (err.name === 'NotFoundError' || err.name === 'NotReadableError'))
        subscriber.complete();
      else subscriber.error(err);
    });
}
//#endregion
//#region src/client/screenshare$.ts
function screenshare$(options) {
  return new Observable((subscriber) => {
    navigator.mediaDevices
      .getDisplayMedia(options)
      .then((ms) => {
        ms.getTracks().forEach((t) => {
          subscriber.add(() => t.stop());
          t.addEventListener('ended', () => {
            return subscriber.complete();
          });
        });
        subscriber.next(ms);
      })
      .catch((err) => {
        invariant(err instanceof Error);
        if (err.name === 'NotAllowedError') {
          subscriber.complete();
          return;
        }
        subscriber.error(err);
      });
  }).pipe(
    share({
      resetOnComplete: true,
      resetOnError: true,
      connector: () => new ReplaySubject(1),
    }),
  );
}
//#endregion
//#region src/client/inaudibleTrack$.ts
const userGestureEvents = [
  'click',
  'contextmenu',
  'auxclick',
  'dblclick',
  'mousedown',
  'mouseup',
  'pointerup',
  'touchend',
  'keydown',
  'keyup',
];
let audioContextStartedPreviously = false;
const inaudibleAudioTrack$ = new Observable((subscriber) => {
  const audioContext = new AudioContext();
  const oscillator = audioContext.createOscillator();
  oscillator.type = 'triangle';
  oscillator.frequency.setValueAtTime(20, audioContext.currentTime);
  const gainNode = audioContext.createGain();
  gainNode.gain.setValueAtTime(0, audioContext.currentTime);
  oscillator.connect(gainNode);
  const destination = audioContext.createMediaStreamDestination();
  gainNode.connect(destination);
  const track = destination.stream.getAudioTracks()[0];
  subscriber.next(track);
  let oscillatorStarted = false;
  const ensureOscillatorStarted = () => {
    if (oscillatorStarted) return;
    oscillator.start();
    oscillatorStarted = true;
  };
  const stateChangeHandler = () => {
    if (audioContext.state === 'running') {
      audioContextStartedPreviously = true;
      ensureOscillatorStarted();
    }
    if (audioContext.state === 'suspended' || audioContext.state === 'interrupted')
      resumeAudioContext();
  };
  audioContext.addEventListener('statechange', stateChangeHandler);
  const resumeAudioContext = () => {
    audioContext.resume().then(() => {
      cleanUpUserGestureListeners();
    });
  };
  const cleanUpUserGestureListeners = () => {
    userGestureEvents.forEach((gesture) => {
      document.removeEventListener(gesture, resumeAudioContext, { capture: true });
    });
  };
  if (audioContextStartedPreviously) resumeAudioContext();
  else
    userGestureEvents.forEach((gesture) => {
      document.addEventListener(gesture, resumeAudioContext, { capture: true });
    });
  return () => {
    track.stop();
    audioContext.close();
    audioContext.removeEventListener('statechange', stateChangeHandler);
    cleanUpUserGestureListeners();
  };
}).pipe(
  shareReplay({
    refCount: true,
    bufferSize: 1,
  }),
);
//#endregion
//#region src/client/blackCanvasTrack$.ts
const blackCanvasTrack$ = new Observable((subscriber) => {
  const canvas = document.createElement('canvas');
  canvas.height = 720;
  canvas.width = 1280;
  const ctx = canvas.getContext('2d');
  invariant(ctx);
  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const i = setInterval(() => {
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, 1e3);
  const track = canvas.captureStream().getVideoTracks()[0];
  track.addEventListener('ended', () => {
    subscriber.complete();
  });
  subscriber.add(() => {
    track.stop();
    clearInterval(i);
  });
  subscriber.next(track);
}).pipe(
  shareReplay({
    refCount: true,
    bufferSize: 1,
  }),
);
//#endregion
//#region src/client/makeBroadcastTrack.ts
const makeBroadcastTrack = ({
  retainIdleTrack,
  broadcasting = false,
  fallbackTrack$,
  contentTrack$,
  transformations = [(track) => of(track)],
  isSourceEnabled$ = new BehaviorSubject(true),
  shouldBroadcast$ = new BehaviorSubject(broadcasting),
}) => {
  const isBroadcasting$ = new BehaviorSubject(false);
  const transformationMiddleware$ = new BehaviorSubject(transformations);
  const enableSource = () => {
    if (!isSourceEnabled$.value) isSourceEnabled$.next(true);
  };
  const disableSource = () => {
    if (isSourceEnabled$.value) {
      isSourceEnabled$.next(false);
      stopBroadcasting();
    }
  };
  const toggleIsSourceEnabled = () => {
    if (isSourceEnabled$.value) disableSource();
    else enableSource();
  };
  const startBroadcasting = () => {
    enableSource();
    if (!shouldBroadcast$.value) shouldBroadcast$.next(true);
  };
  const stopBroadcasting = () => {
    if (shouldBroadcast$.value) shouldBroadcast$.next(false);
  };
  const toggleBroadcasting = () => {
    if (shouldBroadcast$.value) stopBroadcasting();
    else startBroadcasting();
  };
  const error$ = new Subject();
  const addTransform = (transform) => {
    transformationMiddleware$.next(transformationMiddleware$.value.concat(transform));
  };
  const removeTransform = (transform) => {
    transformationMiddleware$.next(transformationMiddleware$.value.filter((t) => t !== transform));
  };
  const enabledContent$ = isSourceEnabled$.pipe(
    switchMap((enabled) =>
      enabled
        ? contentTrack$.pipe(
            tap({
              complete: () => {
                disableSource();
              },
              error: (error) => {
                disableSource();
                if (!(error instanceof Error)) throw error;
                error$.next(error);
              },
            }),
            (source$) =>
              combineLatest([transformationMiddleware$, source$]).pipe(
                switchMap(([transformations, source]) =>
                  transformations.reduce(
                    (acc$, transformFn) => acc$.pipe(switchMap(transformFn)),
                    of(source),
                  ),
                ),
              ),
          )
        : fallbackTrack$,
    ),
  );
  const broadcastTrack$ = combineLatest([isSourceEnabled$, shouldBroadcast$, fallbackTrack$]).pipe(
    switchMap(([enabled, isBroadcasting, fallbackTrack]) =>
      enabled && isBroadcasting
        ? enabledContent$.pipe(tap(() => isBroadcasting$.next(true)))
        : of(fallbackTrack).pipe(tap(() => isBroadcasting$.next(false))),
    ),
    shareReplay({
      refCount: true,
      bufferSize: 1,
    }),
  );
  const localMonitorTrack$ = isSourceEnabled$.pipe(
    switchMap((enabled) => (enabled ? enabledContent$ : fallbackTrack$)),
    shareReplay({
      refCount: true,
      bufferSize: 1,
    }),
  );
  return {
    error$,
    enableSource,
    disableSource,
    toggleIsSourceEnabled,
    isSourceEnabled$: isSourceEnabled$.asObservable(),
    addTransform,
    removeTransform,
    isBroadcasting$: isBroadcasting$.asObservable(),
    startBroadcasting,
    stopBroadcasting,
    toggleBroadcasting,
    localMonitorTrack$,
    broadcastTrack$: retainIdleTrack
      ? combineLatest([broadcastTrack$, localMonitorTrack$]).pipe(
          map(([broadcastTrack]) => broadcastTrack),
        )
      : broadcastTrack$,
  };
};
//#endregion
//#region src/client/getScreenshare.ts
const defaultAudioConfig = {
  constraints: {},
  options: { broadcasting: false },
};
const defaultVideoConfig = {
  constraints: {},
  options: { broadcasting: false },
};
const defaultOptions = {
  activateSource: false,
  retainIdleTracks: false,
};
const getScreenshare = (options = defaultOptions) => {
  const audioConstraints =
    options.audio === true || options.audio === void 0
      ? defaultAudioConfig.constraints
      : options.audio === false
        ? void 0
        : options.audio.constraints;
  const audioBroadcastOptions =
    options.audio === true || options.audio === void 0
      ? defaultAudioConfig.options
      : options.audio === false
        ? defaultAudioConfig.options
        : {
            ...defaultAudioConfig.options,
            ...options.audio.options,
          };
  const videoConstraints =
    options.video === true || options.video === void 0
      ? defaultVideoConfig.constraints
      : options.video === false
        ? void 0
        : options.video.constraints;
  const videoBroadcastOptions =
    options.video === true || options.video === void 0
      ? defaultVideoConfig.options
      : options.video === false
        ? defaultVideoConfig.options
        : {
            ...defaultVideoConfig.options,
            ...options.video.options,
          };
  const screenshareSource$ = screenshare$({
    audio: audioConstraints,
    video: videoConstraints,
  });
  const audioSourceTrack$ = screenshareSource$.pipe(
    switchMap((ms) => {
      const [track] = ms.getAudioTracks();
      return track ? of(track) : inaudibleAudioTrack$;
    }),
  );
  const isSourceEnabled$ = new BehaviorSubject(
    options.activateSource ?? defaultOptions.activateSource,
  );
  const audioShouldBroadcast$ = new BehaviorSubject(audioBroadcastOptions.broadcasting);
  const audioApi = makeBroadcastTrack({
    contentTrack$: audioSourceTrack$,
    fallbackTrack$: inaudibleAudioTrack$,
    ...defaultOptions,
    retainIdleTrack: options.retainIdleTracks,
    shouldBroadcast$: audioShouldBroadcast$,
    isSourceEnabled$,
    ...audioBroadcastOptions,
  });
  const audio = { ...audioApi };
  delete audio.toggleIsSourceEnabled;
  delete audio.disableSource;
  delete audio.enableSource;
  delete audio.isSourceEnabled$;
  const videoSourceTrack$ = screenshareSource$.pipe(map((ms) => ms.getVideoTracks()[0]));
  const videoShouldBroadcast$ = new BehaviorSubject(videoBroadcastOptions.broadcasting);
  const videoApi = makeBroadcastTrack({
    contentTrack$: videoSourceTrack$,
    fallbackTrack$: blackCanvasTrack$,
    retainIdleTrack: options.retainIdleTracks,
    shouldBroadcast$: videoShouldBroadcast$,
    isSourceEnabled$,
    ...videoBroadcastOptions,
  });
  const video = { ...videoApi };
  delete video.toggleIsSourceEnabled;
  delete video.disableSource;
  delete video.enableSource;
  delete video.isSourceEnabled$;
  const disableSource = () => {
    isSourceEnabled$.next(false);
    videoApi.stopBroadcasting();
    audioApi.stopBroadcasting();
  };
  const enableSource = () => {
    isSourceEnabled$.next(true);
  };
  const toggleIsSourceEnabled = () => {
    if (isSourceEnabled$.value) disableSource();
    else enableSource();
  };
  const startBroadcasting = () => {
    audioApi.startBroadcasting();
    videoApi.startBroadcasting();
  };
  const stopBroadcasting = () => {
    audioApi.stopBroadcasting();
    videoApi.stopBroadcasting();
  };
  const toggleBroadcasting = () => {
    if (audioShouldBroadcast$.value || videoShouldBroadcast$.value) stopBroadcasting();
    else startBroadcasting();
  };
  return {
    audio,
    video,
    disableSource,
    enableSource,
    toggleIsSourceEnabled,
    isSourceEnabled$,
    startBroadcasting,
    stopBroadcasting,
    toggleBroadcasting,
    isBroadcasting$: combineLatest([audioApi.isBroadcasting$, videoApi.isBroadcasting$]).pipe(
      map(
        ([audioIsBroadcasting, videoIsBroadcasting]) => audioIsBroadcasting || videoIsBroadcasting,
      ),
      distinctUntilChanged(),
    ),
  };
};
//#endregion
//#region src/client/audioSink.ts
const checkSinkIdSupport = (element) => {
  return 'setSinkId' in element && typeof element.setSinkId === 'function';
};
const createAudioSink = ({ audioElement, sinkId = 'default' }) => {
  const isSinkIdSupported = checkSinkIdSupport(audioElement);
  if (isSinkIdSupported) audioElement.setSinkId(sinkId);
  const sinkId$ = new BehaviorSubject(sinkId);
  const mediaStream = new MediaStream();
  audioElement.srcObject = mediaStream;
  const resetSrcObject = () => {
    audioElement.addEventListener('canplay', () => audioElement.play(), { once: true });
    audioElement.srcObject = mediaStream;
  };
  const subs = [];
  const attach = (pulledAudioTrack$) => {
    const sub = pulledAudioTrack$.subscribe((track) => {
      mediaStream.addTrack(track);
      resetSrcObject();
      sub.add(() => {
        mediaStream.removeTrack(track);
        resetSrcObject();
      });
    });
    subs.push(sub);
    return sub;
  };
  const setSinkId = (sinkId) => {
    if (isSinkIdSupported) {
      audioElement.setSinkId(sinkId);
      sinkId$.next(sinkId);
    } else
      console.warn(
        'setSinkId is not supported on this browser. Audio will play through the default output device.',
      );
  };
  const cleanup = () => {
    subs.forEach((s) => {
      s.unsubscribe();
    });
    audioElement.srcObject = null;
  };
  return {
    attach,
    setSinkId,
    devices$: devices$.pipe(map((devices) => devices.filter((d) => d.kind === 'audiooutput'))),
    cleanup,
    isSinkIdSupported,
  };
};
//#endregion
//#region src/client/permission$.ts
const permission$ = (name) => {
  return concat(
    defer(() => from(navigator.permissions.query({ name }).then((ps) => ps.state))),
    defer(() =>
      from(navigator.permissions.query({ name })).pipe(
        switchMap((permissionStatus) =>
          combineLatest([of(permissionStatus), fromEvent(permissionStatus, 'change')]),
        ),
        map(([permissionStatus]) => permissionStatus.state),
      ),
    ),
  ).pipe(catchError(() => of('unknown')));
};
//#endregion
//#region src/client/deviceManager.ts
function deviceMatch(deviceA, deviceB) {
  return deviceA.kind === deviceB.kind && deviceA.label === deviceB.label;
}
const createDeviceManager = (options) => {
  const preferredDevice$ = localStorageValue$(`${options.localStorageNamespace}-preferred-device`);
  const deprioritizedDevices = localStorageValue$(
    `${options.localStorageNamespace}-deprioritized-devices`,
    [],
  );
  const devicePriority$ = combineLatest([
    preferredDevice$.value$,
    deprioritizedDevices.value$,
    options.devices$,
  ]).pipe(
    map(([preferredDevice, deprioritizedDevices, devices]) =>
      devices
        .toSorted((a, b) => {
          const deprioritizeA = deprioritizedDevices?.some((item) => deviceMatch(a, item));
          const deprioritizeB = deprioritizedDevices?.some((item) => deviceMatch(b, item));
          if (b.label.toLowerCase().includes('virtual')) return -1;
          if (b.label.toLowerCase().includes('iphone microphone')) return -1;
          if (deprioritizeA && !deprioritizeB) return 1;
          else if (!deprioritizeA && deprioritizeB) return -1;
          return 0;
        })
        .toSorted((a, b) => {
          if (preferredDevice && deviceMatch(preferredDevice, a)) return -1;
          else if (preferredDevice && deviceMatch(preferredDevice, b)) return 1;
          else return 0;
        }),
    ),
  );
  const activeDevice$ = combineLatest([options.activeDeviceId$, devicePriority$]).pipe(
    map(([deviceId, devices]) => devices.find((d) => d.deviceId === deviceId) ?? devices[0]),
  );
  return {
    permissionState$: permission$(options.permissionName),
    devices$: options.devices$,
    deprioritizeDevice: (device) =>
      deprioritizedDevices.setValue((deprioritizedDevices) =>
        (deprioritizedDevices ?? []).filter((d) => deviceMatch(d, device)).concat(device),
      ),
    devicePriority$,
    activeDevice$,
    setPreferredDevice: (device) => {
      deprioritizedDevices.setValue(
        (devices) => devices?.filter((d) => deviceMatch(d, device)) ?? [],
      );
      preferredDevice$.setValue(() => device);
    },
  };
};
const isLocalStorageEnabled = (() => {
  try {
    const key = '__partytracks-localstorage-test__';
    localStorage.setItem(key, '');
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
})();
function localStorageValue$(key, defaultValue) {
  if (!isLocalStorageEnabled) {
    const value$ = new BehaviorSubject(defaultValue);
    return {
      value$,
      setValue: (update) => value$.next(update(value$.value)),
    };
  }
  if (getLocalStorage(key) === void 0 && defaultValue !== void 0)
    setLocalStorage(key, () => defaultValue);
  return {
    setValue: (update) => setLocalStorage(key, update),
    value$: merge(
      of(getLocalStorage(key)),
      fromEvent(window, 'storage').pipe(
        map(() => localStorage.getItem(key)),
        distinctUntilChanged(),
        map((value) => (value === null ? void 0 : JSON.parse(value))),
      ),
    ).pipe(
      shareReplay({
        refCount: true,
        bufferSize: 1,
      }),
    ),
  };
}
function setLocalStorage(key, update) {
  if (isLocalStorageEnabled) {
    localStorage.setItem(key, JSON.stringify(update(getLocalStorage(key))));
    window.dispatchEvent(new Event('storage'));
  }
}
function getLocalStorage(key) {
  if (isLocalStorageEnabled) {
    const existingValue = localStorage.getItem(key);
    if (existingValue) return JSON.parse(existingValue);
  }
}
//#endregion
//#region src/client/getDevices.ts
const getDevice = ({ kind, fallbackTrack$, retainIdleTrackDefaultValue, permissionName }) => {
  return ({
    activateSource = true,
    transformations: _transformations,
    retainIdleTrack,
    onDeviceFailure,
    broadcasting,
    ...resilientTrackOptions
  } = {}) => {
    const inputDevices$ = devices$.pipe(map((devices) => devices.filter((d) => d.kind === kind)));
    const activeDeviceId$ = new BehaviorSubject('default');
    const { devicePriority$, deprioritizeDevice, ...deviceManagerPublicApi } = createDeviceManager({
      localStorageNamespace: `partytracks-${kind}`,
      devices$: inputDevices$,
      activeDeviceId$,
      permissionName,
    });
    const sourceTrack$ = resilientTrack$({
      kind,
      devicePriority$,
      onDeviceFailure: (device) => {
        deprioritizeDevice(device);
        if (onDeviceFailure) onDeviceFailure(device);
      },
      onUnconstrainedDeviceSelection: (device) => {
        deviceManagerPublicApi.setPreferredDevice(device);
      },
      ...resilientTrackOptions,
    }).pipe(tap((track) => activeDeviceId$.next(track.getSettings().deviceId ?? 'default')));
    return {
      ...makeBroadcastTrack({
        broadcasting,
        isSourceEnabled$: new BehaviorSubject(activateSource),
        fallbackTrack$,
        contentTrack$: sourceTrack$,
        retainIdleTrack: retainIdleTrack ?? retainIdleTrackDefaultValue,
      }),
      ...deviceManagerPublicApi,
    };
  };
};
const getMic = getDevice({
  kind: 'audioinput',
  fallbackTrack$: inaudibleAudioTrack$,
  retainIdleTrackDefaultValue: true,
  permissionName: 'microphone',
});
const getCamera = getDevice({
  kind: 'videoinput',
  fallbackTrack$: blackCanvasTrack$,
  retainIdleTrackDefaultValue: false,
  permissionName: 'camera',
});
//#endregion
export {
  DevicesExhaustedError,
  PartyTracks,
  createAudioSink,
  devices$,
  getCamera,
  getMic,
  getScreenshare,
  resilientTrack$,
  screenshare$,
  setLogLevel,
};

//# sourceMappingURL=index.js.map
