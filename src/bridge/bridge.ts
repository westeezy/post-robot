import type { ZalgoPromise } from 'zalgo-promise';
import type { CrossDomainWindowType } from 'cross-domain-utils';
import { getParent, isWindowClosed } from 'cross-domain-utils';
import { noop, uniqueID } from 'belter';

import { MESSAGE_NAME, WILDCARD } from '../conf';
import { getGlobal, globalStore } from '../global';
import type { SendType, ResponseMessageEvent } from '../types';

function cleanTunnelWindows() {
    const tunnelWindows = globalStore('tunnelWindows');

    for (const key of tunnelWindows.keys()) {
        // @ts-ignore
        const tunnelWindow = tunnelWindows[key];

        try {
            noop(tunnelWindow.source);
        } catch (err) {
            tunnelWindows.del(key);
            continue;
        }

        if (isWindowClosed(tunnelWindow.source)) {
            tunnelWindows.del(key);
        }
    }
}

export type TunnelWindowDataType = {
    name: string;
    source: CrossDomainWindowType;
    canary: () => void;
    sendMessage: (message: string) => void;
};

function addTunnelWindow({
    name,
    source,
    canary,
    sendMessage
}: TunnelWindowDataType): string {
    cleanTunnelWindows();
    const id = uniqueID();
    const tunnelWindows = globalStore('tunnelWindows');
    tunnelWindows.set(id, {
        name,
        source,
        canary,
        sendMessage
    });
    return id;
}

export function setupOpenTunnelToParent({ send }: { send: SendType }): void {
    getGlobal(window).openTunnelToParent = function openTunnelToParent({
        name,
        source,
        canary,
        sendMessage
    }: TunnelWindowDataType): ZalgoPromise<ResponseMessageEvent> {
        const tunnelWindows = globalStore('tunnelWindows');
        const parentWindow = getParent(window);

        if (!parentWindow) {
            throw new Error(`No parent window found to open tunnel to`);
        }

        const id = addTunnelWindow({
            name,
            source,
            canary,
            sendMessage
        });
        return send(
            parentWindow,
            MESSAGE_NAME.OPEN_TUNNEL,
            {
                name,

                sendMessage() {
                    const tunnelWindow = tunnelWindows.get(id);

                    try {
                        // IE gets antsy if you try to even reference a closed window
                        // @ts-ignore
                        noop(tunnelWindow && tunnelWindow.source);
                    } catch (err) {
                        tunnelWindows.del(id);
                        return;
                    }

                    if (
                        !tunnelWindow ||
                        // @ts-ignore
                        !tunnelWindow.source ||
                        // @ts-ignore
                        isWindowClosed(tunnelWindow.source)
                    ) {
                        return;
                    }

                    try {
                        // @ts-ignore
                        tunnelWindow.canary();
                    } catch (err) {
                        return;
                    }

                    // @ts-ignore
                    tunnelWindow.sendMessage.apply(this, arguments);
                }
            },
            {
                domain: WILDCARD
            }
        );
    };
}
