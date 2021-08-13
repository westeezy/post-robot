import { ZalgoPromise } from 'zalgo-promise';
import type { CrossDomainWindowType, DomainMatcher } from 'cross-domain-utils';
import {
    isAncestor,
    isWindowClosed,
    getDomain,
    matchDomain
} from 'cross-domain-utils';
import {
    uniqueID,
    isRegex,
    noop,
    safeInterval,
    stringify,
    stringifyError
} from 'belter';

import {
    CHILD_WINDOW_TIMEOUT,
    MESSAGE_TYPE,
    WILDCARD,
    MESSAGE_NAME,
    ACK_TIMEOUT,
    RES_TIMEOUT,
    ACK_TIMEOUT_KNOWN,
    RESPONSE_CYCLE_TIME
} from '../conf';
import type { ResponseListenerType } from '../drivers';
import {
    sendMessage,
    addResponseListener,
    deleteResponseListener,
    markResponseListenerErrored
} from '../drivers';
import { awaitWindowHello, sayHello, isWindowKnown } from '../lib';
import { windowStore } from '../global';
import type { SendType } from '../types';

import { on } from './on';

function validateOptions(
    name: string,
    win: CrossDomainWindowType,
    domain: DomainMatcher | null | undefined
) {
    if (!name) {
        throw new Error('Expected name');
    }

    if (domain) {
        if (
            typeof domain !== 'string' &&
            !Array.isArray(domain) &&
            !isRegex(domain)
        ) {
            throw new TypeError(
                `Can not send ${ name }. Expected domain ${ JSON.stringify(
                    domain
                ) } to be a string, array, or regex`
            );
        }
    }

    if (isWindowClosed(win)) {
        throw new Error(`Can not send ${ name }. Target window is closed`);
    }
}

function normalizeDomain(
    win: CrossDomainWindowType,
    targetDomain: DomainMatcher,
    actualDomain: string | null | undefined,
    {
        send
    }: {
        send: SendType;
    }
): ZalgoPromise<string> {
    // @ts-ignore revist ZalgoPromise.try types
    return ZalgoPromise.try(() => {
        if (typeof targetDomain === 'string') {
            return targetDomain;
        }

        return ZalgoPromise.try(() => {
            return (
                actualDomain ||
                sayHello(win, {
                    send
                }).then(({ domain }) => domain)
            );
        }).then((normalizedDomain) => {
            if (!matchDomain(targetDomain, targetDomain)) {
                throw new Error(
                    `Domain ${ stringify(
                        targetDomain
                    ) } does not match ${ stringify(targetDomain) }`
                );
            }

            return normalizedDomain;
        });
    });
}

export const send: SendType = (win, name, data, options) => {
    options = options || {};
    const domainMatcher = options.domain || WILDCARD;
    const responseTimeout = options.timeout || RES_TIMEOUT;
    const childTimeout = options.timeout || CHILD_WINDOW_TIMEOUT;
    const fireAndForget = options.fireAndForget || false;
    return ZalgoPromise.try(() => {
        validateOptions(name, win, domainMatcher);

        if (isAncestor(window, win)) {
            return awaitWindowHello(win, childTimeout);
        }
    })
        // @ts-ignore
        .then(({ domain: actualDomain } = {}) => {
            return normalizeDomain(win, domainMatcher, actualDomain, {
                send
            });
        })
        .then((targetDomain) => {
            const domain = targetDomain;
            const logName =
                name === MESSAGE_NAME.METHOD &&
                data &&
                typeof data.name === 'string'
                    ? `${ data.name }()`
                    : name;

            if (__DEBUG__) {
                console.info('send::req', logName, domain, '\n\n', data); // eslint-disable-line no-console
            }

            const promise = new ZalgoPromise<any>();
            const hash = `${ name }_${ uniqueID() }`;

            if (!fireAndForget) {
                const responseListener: ResponseListenerType = {
                    name,
                    win,
                    // @ts-ignore expects string but may get ZalgoPromise
                    domain,
                    // @ts-ignore promise is unknown T
                    promise
                };
                addResponseListener(hash, responseListener);
                const reqPromises = windowStore<ZalgoPromise<any>[]>('requestPromises').getOrSet(
                    win,
                    () => []
                );
                reqPromises.push(promise);
                promise.catch(() => {
                    markResponseListenerErrored(hash);
                    deleteResponseListener(hash);
                });
                const totalAckTimeout = isWindowKnown(win)
                    ? ACK_TIMEOUT_KNOWN
                    : ACK_TIMEOUT;
                const totalResTimeout = responseTimeout;
                let ackTimeout = totalAckTimeout;
                let resTimeout = totalResTimeout;
                const interval = safeInterval(() => {
                    if (isWindowClosed(win)) {
                        return promise.reject(
                            new Error(
                                `Window closed for ${ name } before ${
                                    responseListener.ack ? 'response' : 'ack'
                                }`
                            )
                        );
                    }

                    if (responseListener.cancelled) {
                        return promise.reject(
                            new Error(
                                `Response listener was cancelled for ${ name }`
                            )
                        );
                    }

                    ackTimeout = Math.max(ackTimeout - RESPONSE_CYCLE_TIME, 0);

                    if (resTimeout !== -1) {
                        resTimeout = Math.max(
                            resTimeout - RESPONSE_CYCLE_TIME,
                            0
                        );
                    }

                    if (!responseListener.ack && ackTimeout === 0) {
                        return promise.reject(
                            new Error(
                                `No ack for postMessage ${ logName } in ${ getDomain() } in ${ totalAckTimeout }ms`
                            )
                        );
                    } else if (resTimeout === 0) {
                        return promise.reject(
                            new Error(
                                `No response for postMessage ${ logName } in ${ getDomain() } in ${ totalResTimeout }ms`
                            )
                        );
                    }
                }, RESPONSE_CYCLE_TIME);
                promise
                    .finally(() => {
                        interval.cancel();
                        reqPromises.splice(reqPromises.indexOf(promise, 1));
                    })
                    .catch(noop);
            }

            return sendMessage(
                win,
                // @ts-ignore expects string but might get ZalgoPromise
                domain,
                {
                    id:    uniqueID(),
                    origin:getDomain(window),
                    type:  MESSAGE_TYPE.REQUEST,
                    hash,
                    name,
                    data,
                    fireAndForget
                },
                {
                    on,
                    send
                }
            ).then(
                () => {
                    return fireAndForget ? promise.resolve() : promise;
                },
                (err) => {
                    throw new Error(
                        `Send request message failed for ${ logName } in ${ getDomain() }\n\n${ stringifyError(
                            err
                        ) }`
                    );
                }
            );
        });
};
