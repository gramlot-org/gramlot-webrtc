/** Resolve livekit-client to the test double: LiveKit is the external dependency of the webrtc collection. */
let url;
export function initialize(data) { url = data; }
export function resolve(specifier, context, nextResolve) {
    if (specifier === 'livekit-client') return {url, shortCircuit: true};
    return nextResolve(specifier, context);
}
