/** Test double of the livekit-client surface used by the rtc collection. */
export const fake = {rooms: [], document: null, connect: () => Promise.resolve(), failures: {}, devices: {}};
export const RoomEvent = Object.fromEntries(['ParticipantConnected', 'ParticipantDisconnected', 'TrackPublished',
    'TrackUnpublished', 'TrackSubscribed', 'TrackUnsubscribed', 'TrackMuted', 'TrackUnmuted', 'LocalTrackPublished',
    'LocalTrackUnpublished', 'ActiveSpeakersChanged', 'ParticipantNameChanged', 'Reconnecting', 'Reconnected',
    'Disconnected', 'ConnectionQualityChanged', 'ParticipantAttributesChanged', 'ParticipantPermissionsChanged',
    'DataReceived', 'MediaDevicesChanged', 'ActiveDeviceChanged'].map(name => [name, name[0].toLowerCase() + name.slice(1)]));
export const DisconnectReason = {1: 'CLIENT_INITIATED', CLIENT_INITIATED: 1, 2: 'DUPLICATE_IDENTITY', DUPLICATE_IDENTITY: 2};
export const Track = {Source: {Camera: 'camera', Microphone: 'microphone', ScreenShare: 'screen_share'}};

export class FakeTrack {
    constructor(kind) { this.kind = kind; this.elements = new Set(); }
    attach(element = fake.document.createElement(this.kind)) { this.elements.add(element); return element; }
    detach(element) { this.elements.delete(element); return [element]; }
}
const KIND = {camera: 'video', screen_share: 'video', microphone: 'audio'};
export class FakeParticipant {
    constructor(identity, name = '') {
        this.identity = identity; this.name = name; this.isSpeaking = false; this.publications = new Map();
        this.connectionQuality = 'unknown'; this.attributes = {};
    }
    publish(source, muted = false) {
        const publication = {source, track: new FakeTrack(KIND[source]), isMuted: muted};
        this.publications.set(source, publication);
        return publication;
    }
    getTrackPublication(source) { return this.publications.get(source); }
    #enabled(source) { const publication = this.publications.get(source); return Boolean(publication && !publication.isMuted); }
    get isMicrophoneEnabled() { return this.#enabled('microphone'); }
    get isCameraEnabled() { return this.#enabled('camera'); }
    get isScreenShareEnabled() { return this.#enabled('screen_share'); }
}
class FakeLocalParticipant extends FakeParticipant {
    constructor(room) { super('local', 'Local'); this.room = room; this.calls = []; this.sent = [];
        this.permissions = {...(fake.permissions ?? {canPublish: true, canSubscribe: true, canPublishData: true})};
    }
    publishData(data, options) {
        if (fake.failures.data) return Promise.reject(fake.failures.data);
        this.sent.push([JSON.parse(new TextDecoder().decode(data)), options]); return Promise.resolve();
    }
    setMicrophoneEnabled(enabled) { return this.#set('microphone', enabled); }
    setCameraEnabled(enabled) { return this.#set('camera', enabled); }
    setScreenShareEnabled(enabled) { return this.#set('screen_share', enabled); }
    #set(source, enabled) {
        this.calls.push([source, enabled]);
        if (enabled && fake.failures[source]) return Promise.reject(fake.failures[source]);
        const publication = this.publications.get(source);
        // LiveKit unmutes an existing muted track instead of publishing a new one.
        if (enabled && publication?.isMuted) { publication.isMuted = false; this.room.emit(RoomEvent.TrackUnmuted, publication, this); }
        else if (enabled) this.room.emit(RoomEvent.LocalTrackPublished, this.publish(source));
        else this.unpublish(source);
        return Promise.resolve();
    }
    unpublish(source) {
        const publication = this.publications.get(source);
        this.publications.delete(source);
        if (publication) this.room.emit(RoomEvent.LocalTrackUnpublished, publication);
    }
}
export class Room {
    static getLocalDevices(kind, requestPermissions) {
        fake.deviceRequests = [...(fake.deviceRequests ?? []), [kind, requestPermissions]];
        return Promise.resolve((fake.devices[kind] ?? []).map(device => ({...device, kind, groupId: 'g'})));
    }
    active = {};
    getActiveDevice(kind) { return this.active[kind]; }
    switchActiveDevice(kind, deviceId) {
        this.localParticipant.calls.push(['device', kind, deviceId]);
        if (fake.failures.device) return Promise.reject(fake.failures.device);
        this.active[kind] = deviceId; this.emit(RoomEvent.ActiveDeviceChanged, kind, deviceId);
        return Promise.resolve(true);
    }
    /** A server data message has no participant; a client message carries its sender. */
    receive(message, participant, topic = 'gramlot.rtc') {
        const payload = new TextEncoder().encode(typeof message === 'string' ? message : JSON.stringify(message));
        this.emit(RoomEvent.DataReceived, payload, participant, 0, topic);
    }
    constructor(options) {
        this.options = options; this.listeners = new Map(); this.remoteParticipants = new Map();
        this.localParticipant = new FakeLocalParticipant(this); this.disconnects = []; fake.rooms.push(this);
    }
    on(event, listener) {
        if (!this.listeners.has(event)) this.listeners.set(event, []);
        this.listeners.get(event).push(listener);
        return this;
    }
    removeAllListeners() { this.listeners.clear(); return this; }
    emit(event, ...args) { for (const listener of this.listeners.get(event) ?? []) listener(...args); }
    connect(url, token) { this.url = url; this.token = token; return fake.connect(this); }
    async disconnect(stopTracks) { this.disconnects.push(stopTracks); }
    join(participant) { this.remoteParticipants.set(participant.identity, participant); this.emit(RoomEvent.ParticipantConnected, participant); }
    leave(participant) { this.remoteParticipants.delete(participant.identity); this.emit(RoomEvent.ParticipantDisconnected, participant); }
}
