import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {register} from 'node:module';
import {JSDOM} from 'jsdom';
import {Gramlot, GramlotBuilder} from '@gramlot/gramlot';
import {defineComponent, defineCollection, Container} from '@gramlot/gramlot/components';
import rtc from '../src/webrtc.js';
import {rtcRoomOptions} from '../src/rtc-room-session.js';
import {fake, FakeParticipant} from './fixtures/fake-livekit-client.mjs';

// The core buttons collection has no public package entry; the tests load its module next to the core index.
const {default: buttons} = await import(new URL('./components/buttons.js', import.meta.resolve('@gramlot/gramlot')));

register(new URL('./fixtures/fake-livekit-loader.mjs', import.meta.url),
    {data: new URL('./fixtures/fake-livekit-client.mjs', import.meta.url).href});

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
// The first dynamic import of LiveKit resolves through the loader hook after an unknown number of tasks.
async function until(condition) {
    for (let attempt = 0; attempt < 200 && !condition(); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(condition());
}

function fixture(t, {secure = true, author = null, extra = []} = {}) {
    const {window} = new JSDOM('<main></main>', {url: 'https://example.test/call'});
    Object.defineProperty(window, 'isSecureContext', {value: secure});
    Object.defineProperty(window.navigator, 'mediaDevices', {value: {getUserMedia() {}, getDisplayMedia() {}}});
    fake.rooms.length = 0; fake.document = window.document; fake.failures = {}; fake.connect = () => Promise.resolve();
    fake.devices = {}; fake.deviceRequests = []; fake.permissions = null;
    const app = new Gramlot({element: window.document.querySelector('main'), transport: false, collections: [buttons, rtc, ...extra]});
    const builder = new GramlotBuilder(null, {collections: [buttons, rtc, ...extra]});
    builder.root.dataSetter({destination_path: 'call.url', value: 'wss://media.example.test'});
    builder.root.dataSetter({destination_path: 'call.token', value: 'token-a'});
    const room = builder.root.rtcRoom({id: 'room', url: '^call.url', token: '^call.token', connect: '^call.connect',
        microphone: '^call.microphone', camera: '^call.camera', screen: '^call.screen', status: '^call.status',
        error: '^call.error', participants: '^call.participants', grid: '^call.grid', hand: '^call.hand',
        reaction: '^call.reaction', lastReaction: '^call.lastReaction', unmuteRequested: '^call.unmuteRequested',
        chat: '^call.chat', lastChat: '^call.lastChat',
        annotation: '^call.annotation', lastAnnotation: '^call.lastAnnotation',
        canPublish: '^call.canPublish', audioInputs: '^call.audioInputs', videoInputs: '^call.videoInputs',
        audioOutputs: '^call.audioOutputs', audioInput: '^call.audioInput', videoInput: '^call.videoInput',
        audioOutput: '^call.audioOutput'});
    author?.(room, builder.root);
    builder.root.toggleButton('Screen', {id: 'share', value: '^call.screen'});
    builder.root.button('Heart', {id: 'heart', fire_heart: 'call.reaction'});
    app.src.startSource(builder.toTytx());
    t.after(() => { app.dispose(); window.close(); });
    const element = window.document.getElementById('room');
    const tiles = () => [...element.shadowRoot.querySelectorAll('.grid .tile')].map(tile =>
        [tile.querySelector('.name').textContent, tile.dataset.source, tile.hasAttribute('data-video')]);
    const get = name => app.data.getItem(`call.${name}`);
    const set = (name, value) => app.data.setItem(`call.${name}`, value);
    const click = id => window.document.getElementById(id).control.dispatchEvent(
        new window.MouseEvent('click', {bubbles: true, composed: true}));
    return {window, app, element, tiles, get, set, click};
}

async function connected(t, options) {
    const f = fixture(t, options);
    f.set('connect', true); await until(() => f.get('status') === 'connected');
    return {...f, room: fake.rooms[0]};
}

test('webrtc grammar is the generated Python grammar and LiveKit loads only on the first connect', async t => {
    assert.deepEqual(rtc.toDocument(), JSON.parse(readFileSync(new URL('../../src/gramlot_webrtc/collections/webrtc/grammar.json', import.meta.url))));
    for (const file of ['webrtc.js', 'rtc-room-session.js']) {
        assert.doesNotMatch(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), /^import .*livekit-client/m);
    }
    const f = fixture(t);
    await flush();
    assert.equal(fake.rooms.length, 0);
    assert.equal(f.get('status'), null);
    f.set('connect', true);
    assert.equal(f.get('status'), 'connecting');
    await until(() => f.get('status') === 'connected');
    const [room] = fake.rooms;
    assert.deepEqual(room.options, rtcRoomOptions);
    assert.deepEqual(room.options, {adaptiveStream: true, dynacast: true, publishDefaults: {simulcast: true}});
    assert.equal(room.url, 'wss://media.example.test'); assert.equal(room.token, 'token-a');
    assert.equal(f.get('status'), 'connected'); assert.equal(f.get('error'), '');
    assert.deepEqual(f.get('participants'), [{identity: 'local', name: 'Local', speaking: false, local: true,
        microphone: false, camera: false, screen: false, connectionQuality: 'unknown', role: null, state: null, hand: false}]);
    assert.deepEqual(f.tiles(), [['Local', 'camera', false]]);
});

test('the grid follows participants and tracks; remote microphones play through audio elements', async t => {
    const f = await connected(t);
    f.set('camera', true); f.set('microphone', true); await flush();
    assert.deepEqual(f.room.localParticipant.calls, [['camera', true], ['microphone', true]]);
    assert.deepEqual(f.tiles(), [['Local', 'camera', true]]);
    const remote = new FakeParticipant('b', 'Bea');
    remote.publish('camera'); remote.publish('screen_share'); const microphone = remote.publish('microphone');
    f.room.join(remote);
    assert.deepEqual(f.tiles(), [['Local', 'camera', true], ['Bea', 'camera', true], ['Bea (screen)', 'screen', true]]);
    assert.equal(f.element.shadowRoot.querySelectorAll('.sounds audio').length, 1);
    assert.equal(microphone.track.elements.size, 1);
    assert.deepEqual(f.get('participants').map(item => [item.identity, item.camera, item.screen, item.microphone, item.local]),
        [['local', true, false, true, true], ['b', true, true, true, false]]);
    remote.isSpeaking = true; f.room.emit('activeSpeakersChanged', [remote]);
    assert.equal(f.element.shadowRoot.querySelectorAll('.tile[data-speaking]').length, 2);
    remote.publications.get('camera').isMuted = true; f.room.emit('trackMuted');
    assert.deepEqual(f.tiles()[1], ['Bea', 'camera', false]);
    f.room.leave(remote);
    assert.deepEqual(f.tiles(), [['Local', 'camera', true]]);
    assert.equal(microphone.track.elements.size, 0);
    assert.equal(f.element.shadowRoot.querySelectorAll('.sounds audio').length, 0);
});

test('a click that writes screen calls LiveKit synchronously, inside the click task', async t => {
    const f = await connected(t);
    const calls = f.room.localParticipant.calls;
    f.window.document.getElementById('share').control.dispatchEvent(new f.window.MouseEvent('click', {bubbles: true, composed: true}));
    // No await between the click and the call: getDisplayMedia keeps the user activation.
    assert.deepEqual(calls, [['screen_share', true]]);
    assert.equal(f.get('screen'), true);
    assert.deepEqual(f.tiles(), [['Local', 'camera', false], ['Local (screen)', 'screen', true]]);
});

test('a screen share ended from the browser writes screen false', async t => {
    const f = await connected(t);
    f.set('screen', true); await flush();
    f.room.localParticipant.unpublish('screen_share');
    assert.equal(f.get('screen'), false);
    assert.deepEqual(f.tiles(), [['Local', 'camera', false]]);
    f.set('screen', true); await flush();
    assert.deepEqual(f.room.localParticipant.calls, [['screen_share', true], ['screen_share', true]]);
});

test('denied permission and missing devices reset the flag and write error without leaving the room', async t => {
    const f = await connected(t);
    fake.failures.camera = Object.assign(new Error('Permission denied'), {name: 'NotAllowedError'});
    fake.failures.microphone = Object.assign(new Error('Requested device not found'), {name: 'NotFoundError'});
    f.set('camera', true); await flush();
    assert.equal(f.get('camera'), false); assert.equal(f.get('error'), 'Camera permission denied');
    f.set('microphone', true); await flush();
    assert.equal(f.get('microphone'), false); assert.equal(f.get('error'), 'Microphone device not found');
    assert.equal(f.get('status'), 'connected'); assert.equal(f.get('connect'), true);
    delete fake.failures.camera;
    f.set('camera', true); await flush();
    assert.equal(f.get('camera'), true);
});

test('reconnection is reported and a server disconnection ends the session with an error', async t => {
    const f = await connected(t);
    f.room.emit('reconnecting'); assert.equal(f.get('status'), 'reconnecting');
    f.room.emit('reconnected'); assert.equal(f.get('status'), 'connected');
    f.set('screen', true); await flush();
    f.room.emit('disconnected', 2); await flush();
    assert.equal(f.get('connect'), false); assert.equal(f.get('screen'), false);
    assert.equal(f.get('status'), 'error');
    assert.equal(f.get('error'), 'Disconnected from the RTC room: DUPLICATE_IDENTITY');
    assert.equal(f.get('participants'), null); assert.deepEqual(f.tiles(), []);
});

test('connect false and pagehide disconnect and stop local tracks; failures never throw', async t => {
    const f = await connected(t);
    f.set('camera', true); f.set('screen', true); await flush();
    f.set('connect', false); await flush();
    assert.deepEqual(f.room.disconnects, [true]);
    assert.equal(f.get('status'), 'disconnected'); assert.equal(f.get('screen'), false); assert.equal(f.get('camera'), true);
    assert.equal(f.get('participants'), null); assert.deepEqual(f.tiles(), []);
    f.set('connect', true); await until(() => f.get('status') === 'connected');
    const second = fake.rooms[1];
    assert.deepEqual(second.localParticipant.calls, [['camera', true]]);
    // A persisted pagehide (back/forward cache) keeps the app: the room itself leaves the call.
    f.window.dispatchEvent(Object.assign(new f.window.Event('pagehide'), {persisted: true})); await flush();
    assert.deepEqual(second.disconnects, [true]); assert.equal(f.get('connect'), false); assert.equal(f.get('status'), 'disconnected');
    fake.connect = () => Promise.reject(new Error('Could not establish signal connection'));
    f.set('connect', true); await until(() => f.get('status') === 'error');
    assert.equal(f.get('connect'), false);
    assert.equal(f.get('error'), 'Could not establish signal connection');
});

test('connect false while LiveKit connects leaves no room open', async t => {
    const f = fixture(t);
    let finish;
    fake.connect = () => new Promise(resolve => { finish = resolve; });
    f.set('connect', true); await until(() => fake.rooms.length === 1);
    f.set('connect', false); await flush();
    finish(); await flush();
    assert.deepEqual(fake.rooms[0].disconnects, [true]);
    assert.equal(f.get('status'), 'disconnected'); assert.equal(f.get('participants'), null);
});

test('insecure contexts and missing credentials write error before LiveKit loads', async t => {
    const f = fixture(t, {secure: false});
    f.set('connect', true); await flush();
    assert.equal(fake.rooms.length, 0);
    assert.equal(f.get('connect'), false); assert.equal(f.get('status'), 'error');
    assert.equal(f.get('error'), 'RTC rooms require HTTPS or localhost and media device support');
    const g = fixture(t);
    g.set('token', ''); g.set('connect', true); await flush();
    assert.equal(fake.rooms.length, 0); assert.equal(g.get('error'), 'RTC room requires url and token');
});

test('removing the room disconnects; an rtcTile shows one track of its enclosing room', async t => {
    const f = await connected(t, {author: room => room.rtcTile({id: 'tile', identity: 'b', source: 'screen'})});
    const tile = f.window.document.getElementById('tile');
    const view = () => [tile.shadowRoot.querySelector('.name').textContent, tile.shadowRoot.querySelector('.tile').hasAttribute('data-video')];
    assert.deepEqual(view(), ['', false]);
    const remote = new FakeParticipant('b', 'Bea');
    const screen = remote.publish('screen_share');
    f.room.join(remote);
    assert.deepEqual(view(), ['Bea (screen)', true]);
    assert.equal(screen.track.elements.size, 2);
    f.element.remove(); await flush();
    assert.deepEqual(f.room.disconnects, [true]);
    assert.equal(screen.track.elements.size, 0);
    const orphan = f.window.document.createElement('gramlot-rtc-tile');
    assert.throws(() => orphan.connectedCallback(), /rtcTile requires an enclosing rtcRoom/);
});

test('participants report connection quality and the server-set role and state', async t => {
    const f = await connected(t);
    const remote = new FakeParticipant('b', 'Bea');
    remote.attributes = {'gramlot.role': 'presenter', 'gramlot.state': 'admitted'}; remote.connectionQuality = 'good';
    f.room.join(remote);
    const entry = () => f.get('participants').find(item => item.identity === 'b');
    assert.deepEqual([entry().role, entry().state, entry().connectionQuality, entry().hand], ['presenter', 'admitted', 'good', false]);
    remote.connectionQuality = 'poor'; f.room.emit('connectionQualityChanged', 'poor', remote);
    assert.equal(entry().connectionQuality, 'poor');
    remote.attributes = {'gramlot.role': 'guest', 'gramlot.state': 'waiting'};
    f.room.emit('participantAttributesChanged', {'gramlot.role': 'guest'}, remote);
    assert.deepEqual([entry().role, entry().state], ['guest', 'waiting']);
});

test('hand is a gramlot.rtc data message: sent to everyone, kept per identity, sent again to a new participant', async t => {
    const f = fixture(t);
    f.set('hand', true);
    f.set('connect', true); await until(() => f.get('status') === 'connected'); await flush();
    const room = fake.rooms[0], local = room.localParticipant;
    assert.deepEqual(local.sent, [[{kind: 'hand', raised: true}, {reliable: true, topic: 'gramlot.rtc'}]]);
    assert.equal(f.get('participants')[0].hand, true);
    const remote = new FakeParticipant('b', 'Bea'); room.join(remote);
    assert.deepEqual(local.sent.at(-1), [{kind: 'hand', raised: true}, {reliable: true, topic: 'gramlot.rtc', destinationIdentities: ['b']}]);
    const entry = () => f.get('participants').find(item => item.identity === 'b');
    room.receive({kind: 'hand', raised: true}, remote);
    assert.equal(entry().hand, true);
    room.receive({kind: 'hand', raised: 'yes'}, remote);
    room.receive({kind: 'hand', raised: false});
    assert.equal(entry().hand, true);
    room.receive({kind: 'hand', raised: false}, remote);
    assert.equal(entry().hand, false);
    room.receive({kind: 'hand', raised: true}, remote);
    room.leave(remote); room.join(remote);
    assert.equal(entry().hand, false);
    // A waiting participant admitted later receives the subscribe permission: the raised hand reaches it then.
    const waiting = new FakeParticipant('c', 'Cleo'); waiting.permissions = {canSubscribe: false};
    fake.permissions = null; local.sent.length = 0;
    f.set('hand', false); await flush();
    assert.deepEqual(local.sent, [[{kind: 'hand', raised: false}, {reliable: true, topic: 'gramlot.rtc'}]]);
    f.set('hand', true); await flush();
    room.join(waiting); local.sent.length = 0;
    const previous = waiting.permissions; waiting.permissions = {canSubscribe: true};
    room.emit('participantPermissionsChanged', previous, waiting);
    assert.deepEqual(local.sent, [[{kind: 'hand', raised: true}, {reliable: true, topic: 'gramlot.rtc', destinationIdentities: ['c']}]]);
    fake.failures.data = new Error('closed');
    f.set('hand', false); await flush();
    assert.equal(f.get('hand'), false);
    assert.equal(f.get('error'), 'Raise hand failed: closed');
    delete fake.failures.data;
    f.set('hand', true); await flush();
    f.set('connect', false); await flush();
    assert.equal(f.get('hand'), false);
});

test('a waiting participant connects without publishing and applies microphone and camera when admitted', async t => {
    const f = fixture(t);
    fake.permissions = {canPublish: false, canSubscribe: false, canPublishData: false};
    f.set('microphone', true); f.set('camera', true); f.set('screen', true); f.set('hand', true);
    f.set('connect', true); await until(() => f.get('status') === 'connected'); await flush();
    const room = fake.rooms[0], local = room.localParticipant;
    assert.equal(f.get('canPublish'), false);
    assert.deepEqual(local.calls.filter(([name]) => name !== 'device'), []);
    assert.deepEqual([f.get('microphone'), f.get('camera'), f.get('screen'), f.get('hand')], [true, true, false, false]);
    assert.equal(f.get('error'), 'Raise hand needs the data permission');
    assert.deepEqual(local.sent, []);
    const previous = local.permissions;
    local.permissions = {canPublish: true, canSubscribe: true, canPublishData: true};
    room.emit('participantPermissionsChanged', previous, local); await flush();
    assert.equal(f.get('canPublish'), true);
    assert.deepEqual(local.calls, [['microphone', true], ['camera', true]]);
    assert.equal(f.get('participants')[0].microphone, true);
});

test('a fired reaction is sent on gramlot.rtc each time; received reactions and server unmute requests reach Data', async t => {
    const f = await connected(t);
    const local = f.room.localParticipant;
    f.click('heart'); await flush();
    assert.deepEqual(local.sent, [[{kind: 'reaction', value: 'heart'}, {reliable: true, topic: 'gramlot.rtc'}]]);
    assert.equal(f.get('reaction'), null);
    assert.equal(f.get('lastReaction').identity, 'local'); assert.equal(f.get('lastReaction').value, 'heart');
    f.click('heart'); await flush();
    assert.equal(local.sent.length, 2);
    // Unrelated projections do not send the reaction again.
    f.set('camera', true); await flush();
    assert.equal(local.sent.length, 2);
    const remote = new FakeParticipant('b', 'Bea'); f.room.join(remote);
    f.room.receive({kind: 'reaction', value: 'clap'}, remote);
    assert.deepEqual([f.get('lastReaction').identity, f.get('lastReaction').value], ['b', 'clap']);
    assert.match(f.get('lastReaction').at, /^\d{4}-\d\d-\d\dT/);
    // Server messages carry no participant; only they may ask for an unmute.
    f.room.receive({kind: 'unmute-request'}, remote);
    f.room.receive({kind: 'reaction', value: 'x'});
    f.room.receive({kind: 'reaction', value: 'y'}, remote, 'other-topic');
    f.room.receive('not json', remote);
    f.room.receive({kind: 'note', text: 'later'}, remote);
    assert.notEqual(f.get('unmuteRequested'), true); assert.equal(f.get('lastReaction').value, 'clap');
    f.room.receive({kind: 'unmute-request'});
    assert.equal(f.get('unmuteRequested'), true);
    f.set('unmuteRequested', false); f.set('microphone', true); await flush();
    assert.deepEqual(local.calls.at(-1), ['microphone', true]);
    f.set('connect', false); await flush();
    f.click('heart'); await flush();
    assert.equal(f.get('error'), 'Reaction failed: RTC room is not connected');
});

test('annotations: a fired pointer goes lossy without echo, other kinds reliable with echo; received ones are checked', async t => {
    const f = await connected(t);
    const local = f.room.localParticipant;
    const fire = message => { f.set('annotation', message); f.set('annotation', null); };
    fire({kind: 'pointer', share: 'b', x: 0.5, y: 0.25}); await flush();
    assert.deepEqual(local.sent.at(-1), [{kind: 'pointer', share: 'b', x: 0.5, y: 0.25}, {reliable: false, topic: 'gramlot.rtc'}]);
    assert.equal(f.get('lastAnnotation'), null);
    const shape = {type: 'arrow', x: 0.1, y: 0.2, x2: 0.3, y2: 0.4, color: '#dd2222', width: 3};
    fire({kind: 'stroke', share: 'b', id: 's_1', shape}); await flush();
    assert.deepEqual(local.sent.at(-1), [{kind: 'stroke', share: 'b', id: 's_1', shape, author: 'local'}, {reliable: true, topic: 'gramlot.rtc'}]);
    assert.equal(f.get('lastAnnotation').identity, 'local'); assert.equal(f.get('lastAnnotation').message.id, 's_1');
    // Clear and lock are for the host only.
    fire({kind: 'strokes-clear', share: 'b'}); await flush();
    assert.equal(local.sent.length, 2); assert.equal(f.get('error'), 'Annotation not allowed');
    local.attributes['gramlot.role'] = 'admin'; f.room.emit('participantAttributesChanged');
    fire({kind: 'draw-lock', locked: true}); await flush();
    assert.deepEqual(local.sent.at(-1)[0], {kind: 'draw-lock', locked: true});
    const remote = new FakeParticipant('b', 'Bea'); f.room.join(remote);
    f.room.receive({kind: 'stroke', share: 'b', id: 's_2', author: 'someone-else', shape}, remote);
    assert.deepEqual([f.get('lastAnnotation').identity, f.get('lastAnnotation').name, f.get('lastAnnotation').message.author], ['b', 'Bea', 'b']);
    f.room.receive({kind: 'pointer', share: 'b', x: 0.9, y: 0.1}, remote);
    assert.equal(f.get('lastAnnotation').message.kind, 'pointer');
    // The sharer deletes any shape of its share; a non-host cannot clear or lock; malformed messages are ignored.
    f.room.receive({kind: 'stroke-delete', share: 'b', id: 's_1'}, remote);
    assert.equal(f.get('lastAnnotation').message.kind, 'stroke-delete');
    for (const message of [{kind: 'stroke-delete', share: 'other', id: 's_1'}, {kind: 'strokes-clear', share: 'b'},
        {kind: 'draw-lock', locked: true}, {kind: 'pointer', share: 'b', x: 2, y: 0}, {kind: 'stroke', share: 'b', id: 'bad id', shape},
        {kind: 'stroke', share: 'b', id: 's_3', shape: {...shape, type: 'star'}}]) f.room.receive(message, remote);
    assert.equal(f.get('lastAnnotation').message.kind, 'stroke-delete');
    remote.attributes['gramlot.role'] = 'admin';
    f.room.receive({kind: 'strokes-clear', share: 'b'}, remote);
    assert.equal(f.get('lastAnnotation').message.kind, 'strokes-clear');
});

test('device lists come from LiveKit without a permission prompt; selection switches the active device', async t => {
    const f = fixture(t);
    fake.devices = {audioinput: [{deviceId: 'mic-1', label: 'Mic'}], videoinput: [{deviceId: 'cam-1', label: 'Cam 1'},
        {deviceId: 'cam-2', label: 'Cam 2'}], audiooutput: [{deviceId: 'spk-1', label: 'Speaker'}]};
    f.set('videoInput', 'cam-2');
    f.set('camera', true);
    f.set('connect', true); await until(() => f.get('status') === 'connected'); await flush();
    const room = fake.rooms[0];
    // The device chosen before connecting applies before the camera track is created.
    assert.deepEqual(room.localParticipant.calls, [['device', 'videoinput', 'cam-2'], ['camera', true]]);
    assert.deepEqual(f.get('videoInputs'), [{deviceId: 'cam-1', label: 'Cam 1'}, {deviceId: 'cam-2', label: 'Cam 2'}]);
    assert.deepEqual(f.get('audioInputs'), [{deviceId: 'mic-1', label: 'Mic'}]);
    assert.deepEqual(f.get('audioOutputs'), [{deviceId: 'spk-1', label: 'Speaker'}]);
    assert.ok(fake.deviceRequests.every(([, request]) => request === false));
    f.set('audioOutput', 'spk-1'); await flush();
    assert.deepEqual(room.localParticipant.calls.at(-1), ['device', 'audiooutput', 'spk-1']);
    room.active.audioinput = 'mic-1'; room.emit('activeDeviceChanged', 'audioinput', 'mic-1');
    assert.equal(f.get('audioInput'), 'mic-1');
    fake.devices.audioinput.push({deviceId: 'mic-2', label: 'Headset'}); room.emit('mediaDevicesChanged'); await flush();
    assert.equal(f.get('audioInputs').length, 2);
    fake.failures.device = new Error('Requested device not found');
    f.set('audioInput', 'mic-2'); await flush();
    assert.equal(f.get('error'), 'Device selection failed: Requested device not found');
});

test('a server mute and a revoked publish permission write the local flags back', async t => {
    const f = await connected(t);
    assert.equal(f.get('canPublish'), true);
    f.set('microphone', true); f.set('camera', true); await flush();
    const local = f.room.localParticipant, microphone = local.publications.get('microphone');
    microphone.isMuted = true; f.room.emit('trackMuted', microphone, local);
    assert.equal(f.get('microphone'), false);
    assert.equal(f.get('participants')[0].microphone, false);
    f.set('microphone', true); await flush();
    assert.deepEqual(local.calls.at(-1), ['microphone', true]);
    assert.equal(microphone.isMuted, false); assert.equal(f.get('participants')[0].microphone, true);
    const granted = local.permissions; local.permissions = {...granted, canPublish: false};
    f.room.emit('participantPermissionsChanged', granted, local);
    assert.equal(f.get('canPublish'), false);
    assert.equal(f.get('microphone'), false); assert.equal(f.get('camera'), false);
    f.set('connect', false); await flush();
    assert.equal(f.get('canPublish'), null);
});

test('grid false draws no internal grid; rtcTiles still show tracks and remote audio still plays', async t => {
    const f = fixture(t, {author: room => room.rtcTile({id: 'tile', identity: 'b'})});
    f.set('grid', false);
    f.set('connect', true); await until(() => f.get('status') === 'connected');
    const room = fake.rooms[0], remote = new FakeParticipant('b', 'Bea');
    const camera = remote.publish('camera'); remote.publish('microphone'); room.join(remote);
    assert.deepEqual(f.tiles(), []);
    assert.equal(f.element.shadowRoot.querySelector('.grid').hidden, true);
    assert.equal(f.element.shadowRoot.querySelectorAll('.sounds audio').length, 1);
    const tile = f.window.document.getElementById('tile');
    assert.equal(tile.shadowRoot.querySelector('.tile').hasAttribute('data-video'), true);
    assert.equal(camera.track.elements.size, 1);
    f.set('grid', true); await flush();
    assert.deepEqual(f.tiles(), [['Local', 'camera', false], ['Bea', 'camera', true]]);
    f.set('grid', false); await flush();
    assert.deepEqual(f.tiles(), []); assert.equal(camera.track.elements.size, 1);
});

test('rtcTile aspectRatio shapes the tile and is offered to a parent declaring that child parameter', async t => {
    const seen = [];
    const Holder = defineComponent({name: 'tileHolder', tag: 'gramlot-test-tile-holder', base: Container, subTags: '*',
        childParameters: {aspectRatio: {dtype: 'N', nullable: true, default: null}},
        implementation: Base => class extends Base {
            static projectChild(box, attrs) { const {aspectRatio = null, ...rest} = attrs; seen.push(aspectRatio); return rest; }
        }});
    const holder = defineCollection({name: 'tileholder', components: [Holder]});
    const f = await connected(t, {extra: [holder], author: room => {
        room.rtcTile({id: 'plain', identity: 'b', aspectRatio: 4 / 3});
        const box = room.tileHolder();
        box.rtcTile({id: 'held', identity: 'b'});
        box.rtcTile({id: 'square', identity: 'b', aspectRatio: 1});
    }});
    const ratio = id => f.window.document.getElementById(id).shadowRoot.querySelector('.tile').style.aspectRatio;
    assert.equal(ratio('plain'), String(4 / 3));
    assert.deepEqual(seen.slice(0, 2), [16 / 9, 1]);
    assert.equal(ratio('held'), String(16 / 9)); assert.equal(ratio('square'), '1');
});

test('a fired chat goes to everyone or, with `to`, to one identity; received chats and sent ones reach lastChat', async t => {
    const f = await connected(t);
    const local = f.room.localParticipant;
    let roomNode = null;
    const walk = bag => { for (const n of bag.getNodes()) { if (n.nodeTag === 'rtcRoom') roomNode = n; if (n.value?.getNodes) walk(n.value); } };
    walk(f.app.src.source);
    roomNode.FIRE('call.chat', {text: 'hello all'}); await flush();
    assert.deepEqual(local.sent.at(-1), [{kind: 'chat', text: 'hello all', private: false}, {reliable: true, topic: 'gramlot.rtc'}]);
    assert.equal(f.get('chat'), null);
    assert.deepEqual((({identity, text, private: p, to, local: l}) => [identity, text, p, to, l])(f.get('lastChat')),
        ['local', 'hello all', false, null, true]);
    roomNode.FIRE('call.chat', {text: 'only you', to: 'b'}); await flush();
    assert.deepEqual(local.sent.at(-1), [{kind: 'chat', text: 'only you', private: true},
        {reliable: true, topic: 'gramlot.rtc', destinationIdentities: ['b']}]);
    assert.deepEqual([f.get('lastChat').to, f.get('lastChat').private], ['b', true]);
    // Unrelated projections do not send again.
    f.set('camera', true); await flush();
    assert.equal(local.sent.length, 2);
    assert.throws(() => roomNode.FIRE('call.chat', {text: '  '}), /requires a text/);
    const remote = new FakeParticipant('b', 'Bea'); f.room.join(remote);
    f.room.receive({kind: 'chat', text: 'psst', private: true}, remote);
    assert.deepEqual((({identity, text, private: p, local: l}) => [identity, text, p, l])(f.get('lastChat')), ['b', 'psst', true, false]);
    f.room.receive({kind: 'chat', text: 'hi'}, remote);
    assert.equal(f.get('lastChat').private, false);
    // Malformed chats and server messages are ignored; they do not ask for an unmute either.
    f.room.receive({kind: 'chat', text: ''}, remote);
    f.room.receive({kind: 'chat', text: 3}, remote);
    f.room.receive({kind: 'chat', text: 'server'});
    assert.equal(f.get('lastChat').text, 'hi'); assert.notEqual(f.get('unmuteRequested'), true);
});
