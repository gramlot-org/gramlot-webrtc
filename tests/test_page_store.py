"""RtcRooms and RtcPageStore: invitations, tokens, admission through LiveKit, lobby and administrator calls.

Only the LiveKit HTTP API is replaced, by a local Twirp server speaking the SDK's protobuf messages.
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4

import pytest
from genro_bag import Bag
from genro_tytx import from_tytx

import livekit.api as livekit_api
from livekit.protocol import egress as egress_proto, models, room as room_proto

from gramlot_webrtc import RtcPageStore, RtcRooms
from gramlot_webrtc import rooms as rtc

KEY, SECRET = 'test-key', 'test-secret-with-enough-length-for-hmac'


@pytest.fixture
def credentials(monkeypatch):
    monkeypatch.setenv('LIVEKIT_URL', 'http://127.0.0.1:9')
    monkeypatch.setenv('LIVEKIT_API_KEY', KEY)
    monkeypatch.setenv('LIVEKIT_API_SECRET', SECRET)


def test_missing_credentials_are_named(monkeypatch, credentials):
    monkeypatch.delenv('LIVEKIT_API_SECRET')
    with pytest.raises(RuntimeError, match='LIVEKIT_API_SECRET'):
        RtcPageStore()


def test_invitation_roundtrip_and_explicit_errors(credentials, monkeypatch):
    store = RtcPageStore()
    invitation = store.rooms.create_invitation('daily', 'guest', name='Ada', expires_in=60)
    claims = store.rooms.verify_invitation(invitation)
    assert (claims['room'], claims['role'], claims['name']) == ('daily', 'guest', 'Ada')
    payload, signature = invitation.split('.')
    with pytest.raises(rtc.InvitationInvalid, match='signature'):
        store.rooms.verify_invitation(payload + '.' + signature[:-2] + ('AA' if signature[-2:] != 'AA' else 'BB'))
    forged = rtc._b64encode(json.dumps(dict(room='daily', role='admin', exp=claims['exp'], name='Ada')).encode())
    with pytest.raises(rtc.InvitationInvalid):
        store.rooms.verify_invitation(forged + '.' + signature)
    with pytest.raises(rtc.InvitationInvalid, match='Malformed'):
        store.rooms.verify_invitation('no-dot')
    with pytest.raises(ValueError):
        store.rooms.create_invitation('', 'guest')
    monkeypatch.setenv('LIVEKIT_API_SECRET', 'another-secret')
    with pytest.raises(rtc.InvitationInvalid, match='signature'):
        RtcPageStore().rooms.verify_invitation(invitation)
    monkeypatch.setenv('LIVEKIT_API_SECRET', SECRET)
    now = rtc.time.time()
    monkeypatch.setattr(rtc.time, 'time', lambda: now + 61)
    with pytest.raises(rtc.InvitationExpired):
        store.rooms.verify_invitation(invitation)


def test_tokens_per_role_without_own_metadata_updates(credentials):
    store = RtcPageStore()
    verifier = livekit_api.TokenVerifier(KEY, SECRET)
    claims = {role: verifier.verify(store.rooms.issue_token('daily', role, name='Ada')) for role in rtc.ROLES}
    assert len({c.identity for c in claims.values()}) == 3
    for role, c in claims.items():
        assert c.name == 'Ada' and c.attributes == {'gramlot.role': role, 'gramlot.state': 'admitted'}
        assert c.video.room == 'daily' and c.video.room_join and not c.video.can_update_own_metadata
        assert c.video.can_publish and c.video.can_subscribe and c.video.can_publish_data
        assert bool(c.video.room_admin) is (role == 'admin')
    waiting = verifier.verify(store.rooms.issue_token('daily', 'guest', name='Eve', waiting=True))
    assert waiting.attributes == {'gramlot.role': 'guest', 'gramlot.state': 'waiting'}
    assert not (waiting.video.can_publish or waiting.video.can_subscribe or waiting.video.can_publish_data)
    with pytest.raises(ValueError):
        store.rooms.issue_token('daily', 'admin', name='Root', waiting=True)
    with pytest.raises(ValueError):
        store.rooms.issue_token('daily', 'owner', name='Ada')


class FakeLiveKit:
    """The RoomService HTTP API of one LiveKit server: rooms with metadata and their participants."""

    def __init__(self):
        self.methods = dict(ListRooms=(room_proto.ListRoomsRequest, room_proto.ListRoomsResponse),
                            CreateRoom=(room_proto.CreateRoomRequest, models.Room),
                            UpdateRoomMetadata=(room_proto.UpdateRoomMetadataRequest, models.Room),
                            GetParticipant=(room_proto.RoomParticipantIdentity, models.ParticipantInfo),
                            ListParticipants=(room_proto.ListParticipantsRequest, room_proto.ListParticipantsResponse),
                            MutePublishedTrack=(room_proto.MuteRoomTrackRequest, room_proto.MuteRoomTrackResponse),
                            RemoveParticipant=(room_proto.RoomParticipantIdentity, room_proto.RemoveParticipantResponse),
                            UpdateParticipant=(room_proto.UpdateParticipantRequest, models.ParticipantInfo),
                            SendData=(room_proto.SendDataRequest, room_proto.SendDataResponse),
                            DeleteRoom=(room_proto.DeleteRoomRequest, room_proto.DeleteRoomResponse),
                            StartRoomCompositeEgress=(egress_proto.RoomCompositeEgressRequest, egress_proto.EgressInfo),
                            StopEgress=(egress_proto.StopEgressRequest, egress_proto.EgressInfo),
                            ListEgress=(egress_proto.ListEgressRequest, egress_proto.ListEgressResponse))
        self.rooms = {}
        self.egresses = {}
        self.participants = {}
        self.data = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def refuse(self, code):
                self.send_response(code)
                self.end_headers()

            def do_POST(self):
                method = self.path.rsplit('/', 1)[-1]
                request_class, response_class = fake.methods[method]
                message = request_class.FromString(self.rfile.read(int(self.headers['Content-Length'])))
                grants = livekit_api.TokenVerifier(KEY, SECRET).verify(
                    self.headers['Authorization'].removeprefix('Bearer ')).video
                if method in ('StartRoomCompositeEgress', 'StopEgress', 'ListEgress'):
                    authorized = grants.room_record
                elif method == 'ListRooms':
                    authorized = grants.room_list
                elif method in ('CreateRoom', 'DeleteRoom'):
                    authorized = grants.room_create
                else:
                    authorized = grants.room_admin and grants.room == message.room
                if not authorized:
                    return self.refuse(401)
                if hasattr(message, 'room') and method not in ('CreateRoom', 'DeleteRoom') and message.room not in fake.rooms:
                    return self.refuse(404)
                body = getattr(fake, method)(message, response_class).SerializeToString()
                self.send_response(200)
                self.send_header('Content-Type', 'application/protobuf')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'

    def connect(self, result, *sources, state='ACTIVE'):
        """Connect the participant of a join result, with the identity, name, attributes and grants of its token."""
        claims = livekit_api.TokenVerifier(KEY, SECRET).verify(result['token'])
        tracks = [models.TrackInfo(sid=f'TR_{claims.identity}_{s}', source=getattr(models.TrackSource, s), muted=False)
                  for s in sources]
        permission = models.ParticipantPermission(can_publish=bool(claims.video.can_publish),
                                                  can_subscribe=bool(claims.video.can_subscribe),
                                                  can_publish_data=bool(claims.video.can_publish_data))
        self.participants[claims.video.room][claims.identity] = models.ParticipantInfo(
            identity=claims.identity, name=claims.name, tracks=tracks, attributes=claims.attributes,
            permission=permission, state=getattr(models.ParticipantInfo.State, state), joined_at=1000)
        return claims.identity

    def add(self, room, identity, role, *sources):
        tracks = [models.TrackInfo(sid=f'TR_{identity}_{s}', source=getattr(models.TrackSource, s), muted=False)
                  for s in sources]
        self.participants[room][identity] = models.ParticipantInfo(
            identity=identity, tracks=tracks, state=models.ParticipantInfo.State.ACTIVE,
            attributes={'gramlot.role': role, 'gramlot.state': 'admitted'})

    def settings(self, room):
        return json.loads(self.rooms[room].metadata)

    def muted(self, room, identity):
        return {models.TrackSource.Name(t.source) for t in self.participants[room][identity].tracks if t.muted}

    def ListRooms(self, message, response):
        names = message.names or list(self.rooms)
        return response(rooms=[self.rooms[name] for name in names if name in self.rooms])

    def CreateRoom(self, message, response):
        if message.name not in self.rooms:
            self.rooms[message.name] = response(name=message.name, metadata=message.metadata)
            self.participants[message.name] = {}
        return self.rooms[message.name]

    def UpdateRoomMetadata(self, message, response):
        self.rooms[message.room].metadata = message.metadata
        return self.rooms[message.room]

    def GetParticipant(self, message, response):
        return self.participants[message.room][message.identity]

    def ListParticipants(self, message, response):
        return response(participants=list(self.participants[message.room].values()))

    def MutePublishedTrack(self, message, response):
        track = next(t for t in self.participants[message.room][message.identity].tracks if t.sid == message.track_sid)
        track.muted = message.muted
        return response(track=track)

    def RemoveParticipant(self, message, response):
        del self.participants[message.room][message.identity]
        return response()

    def UpdateParticipant(self, message, response):
        participant = self.participants[message.room][message.identity]
        participant.attributes.update(message.attributes)
        if message.HasField('permission'):
            participant.permission.CopyFrom(message.permission)
        return participant

    def SendData(self, message, response):
        self.data.append(message)
        return response()

    def DeleteRoom(self, message, response):
        del self.rooms[message.room]
        del self.participants[message.room]
        return response()

    def StartRoomCompositeEgress(self, message, response):
        egress_id = f'EG_{len(self.egresses) + 1}'
        self.egresses[egress_id] = response(egress_id=egress_id, room_name=message.room_name,
                                            status=egress_proto.EgressStatus.EGRESS_ACTIVE, room_composite=message)
        return self.egresses[egress_id]

    def StopEgress(self, message, response):
        self.egresses[message.egress_id].status = egress_proto.EgressStatus.EGRESS_ENDING
        return self.egresses[message.egress_id]

    def ListEgress(self, message, response):
        active = {egress_proto.EgressStatus.EGRESS_STARTING, egress_proto.EgressStatus.EGRESS_ACTIVE}
        return response(items=[info for info in self.egresses.values()
                               if (not message.room_name or info.room_name == message.room_name)
                               and (not message.active or info.status in active)])


@pytest.fixture
def livekit(credentials, monkeypatch):
    fake = FakeLiveKit()
    monkeypatch.setenv('LIVEKIT_URL', fake.url)
    yield fake
    fake.server.shutdown()


def admin_in(livekit, room, **settings):
    """An administrator page joined and connected to ``room``."""
    admin = RtcPageStore()
    result = admin.join(admin.rooms.create_invitation(room, 'admin', name='Root'), **settings)
    livekit.connect(result, 'MICROPHONE')
    return admin


def test_guests_wait_for_an_administrator_in_the_room(livekit):
    issuer = RtcPageStore()
    guest = RtcPageStore()
    invitation = issuer.rooms.create_invitation('meet', 'guest')
    waiting = guest.join(invitation, name='Bob')
    assert waiting == dict(status='waitingForAdmin', room='meet', role='guest', name='Bob', title='meet')
    assert guest.joined is None and 'meet' not in livekit.rooms
    admin = RtcPageStore()
    result = admin.join(issuer.rooms.create_invitation('meet', 'admin', name='Root'))
    assert result['status'] == 'admitted' and result['url'] == livekit.url
    assert livekit.settings('meet') == dict(admission='link', allowed=[], locked=False)
    assert guest.join(invitation, name='Bob')['status'] == 'waitingForAdmin'
    livekit.connect(result, state='JOINING')
    assert guest.join(invitation, name='Bob')['status'] == 'waitingForAdmin'
    livekit.add('meet', 'impostor', 'guest')
    livekit.participants['meet']['impostor'].attributes['gramlot.role'] = 'presenter'
    assert guest.join(invitation, name='Bob')['status'] == 'waitingForAdmin'
    livekit.connect(result)
    admitted = guest.join(invitation, name='Bob')
    assert admitted['status'] == 'admitted' and admitted['name'] == 'Bob' and guest.joined['role'] == 'guest'
    with pytest.raises(RuntimeError):
        guest.join(invitation, name='Bob')
    with pytest.raises(ValueError):
        RtcPageStore().join(invitation)


def test_list_rule_lock_and_settings_from_the_administrator(livekit):
    admin = admin_in(livekit, 'listed', admission='list', allowed=['Ada'])
    assert livekit.settings('listed') == dict(admission='list', allowed=['Ada'], locked=False)
    listed = RtcPageStore()
    assert listed.join(admin.rooms.create_invitation('listed', 'guest', name='Ada'))['status'] == 'admitted'
    with pytest.raises(rtc.AdmissionRefused, match='list'):
        RtcPageStore().join(admin.rooms.create_invitation('listed', 'guest'), name='Ada')
    with pytest.raises(rtc.NotRoomAdmin):
        RtcPageStore().join(admin.rooms.create_invitation('listed', 'guest', name='Ada'), admission='link')
    with pytest.raises(rtc.NotRoomAdmin):
        listed.lock_room()
    admin.configure_room(allowed=['Ada', 'Bob'])
    assert livekit.settings('listed') == dict(admission='list', allowed=['Ada', 'Bob'], locked=False)
    admin.lock_room()
    assert livekit.settings('listed')['locked'] is True
    with pytest.raises(rtc.AdmissionRefused, match='locked'):
        RtcPageStore().join(admin.rooms.create_invitation('listed', 'guest', name='Bob'))
    rejoined = RtcPageStore().join(admin.rooms.create_invitation('listed', 'admin', name='Root'))
    assert rejoined['status'] == 'admitted' and livekit.settings('listed')['locked'] is True
    with pytest.raises(ValueError):
        admin.configure_room(admission='open')
    with pytest.raises(ValueError):
        admin.configure_room(allowed='Ada')
    livekit.rooms['listed'].metadata = 'not json'
    with pytest.raises(rtc.RoomSettingsInvalid):
        RtcPageStore().join(admin.rooms.create_invitation('listed', 'guest', name='Ada'))


def test_lobby_waiting_participants_admit_and_deny(livekit):
    admin = admin_in(livekit, 'meet', admission='lobby')
    eve, mallory = RtcPageStore(), RtcPageStore()
    waiting = eve.join(admin.rooms.create_invitation('meet', 'guest'), name='Eve')
    assert waiting['status'] == 'waiting' and eve.joined['name'] == 'Eve'
    claims = livekit_api.TokenVerifier(KEY, SECRET).verify(waiting['token'])
    assert claims.attributes['gramlot.state'] == 'waiting' and not claims.video.can_publish
    eve_id = livekit.connect(waiting)
    mallory_id = livekit.connect(mallory.join(admin.rooms.create_invitation('meet', 'presenter'), name='Mallory'))
    queue = admin.lobby_queue()
    assert [(e['identity'], e['name'], e['role'], e['since']) for e in queue] == [
        (eve_id, 'Eve', 'guest', 1000), (mallory_id, 'Mallory', 'presenter', 1000)]
    with pytest.raises(rtc.NotRoomAdmin):
        eve.admit(eve_id)
    admin.admit(eve_id)
    admitted = livekit.participants['meet'][eve_id]
    assert admitted.attributes['gramlot.state'] == 'admitted' and admitted.attributes['gramlot.role'] == 'guest'
    assert admitted.permission.can_publish and admitted.permission.can_subscribe
    assert admitted.permission.can_publish_data and not admitted.permission.can_update_metadata
    with pytest.raises(ValueError, match='No waiting participant'):
        admin.admit(eve_id)
    admin.deny(mallory_id)
    assert mallory_id not in livekit.participants['meet'] and admin.lobby_queue() == []
    third = livekit.connect(RtcPageStore().join(admin.rooms.create_invitation('meet', 'guest'), name='Zed'))
    admin.admit_all()
    assert livekit.participants['meet'][third].attributes['gramlot.state'] == 'admitted'


def requests_of(store, events):
    """Send page requests to a started store through its Data, as the page binder does."""
    store.subscribe('client', 'rtc', lambda wire: events.append(from_tytx(wire)))

    def request(action, **params):
        store.change('client', dict(path='request', evt='upd_value', attr={},
                                    value=Bag(dict(id=uuid4().hex, action=action, **params))))
        return store.data.get_item('rtc.response')
    return request


def test_page_requests_through_store_data(livekit):
    admin = admin_in(livekit, 'open')
    store, owner = RtcPageStore(), RtcPageStore()
    events = []
    store.start()
    owner.start()
    try:
        request = requests_of(store, events)
        response = request('join', invitation=admin.rooms.create_invitation('open', 'guest'), name='Ann')
        assert response.get_item('accepted') is True
        assert response.get_item('value.status') == 'admitted' and response.get_item('value.token')
        assert events[-1]['path'] == 'response'
        refused = request('mute', identity='someone')
        assert refused.get_item('accepted') is False
        assert refused.get_item('error') == 'Only the room administrator can do this'
        assert 'Unknown RTC action' in request('explode').get_item('error')
        request = requests_of(owner, [])
        joined = request('join', invitation=admin.rooms.create_invitation('open', 'admin', name='Root'),
                         admission='list', allowed=Bag(dict(n0='Ada')))
        assert joined.get_item('accepted') is True
        assert livekit.settings('open') == dict(admission='list', allowed=['Ada'], locked=False)
        assert request('lock', locked=True).get_item('accepted') is True
        assert request('configure', admission='lobby').get_item('accepted') is True
        assert livekit.settings('open') == dict(admission='lobby', allowed=['Ada'], locked=True)
        assert request('lobbyQueue').get_item('value') == Bag()
    finally:
        store.close()
        owner.close()


def test_administrator_calls(livekit):
    admin = RtcPageStore()
    result = admin.join(admin.rooms.create_invitation('meet', 'admin', name='Root'))
    me = livekit.connect(result, 'MICROPHONE')
    livekit.add('meet', 'guest1', 'guest', 'MICROPHONE', 'CAMERA', 'SCREEN_SHARE', 'SCREEN_SHARE_AUDIO')
    livekit.add('meet', 'guest2', 'guest', 'MICROPHONE')
    livekit.add('meet', 'speaker', 'presenter', 'MICROPHONE')
    assert admin.mute_microphone('guest1') == 1 and livekit.muted('meet', 'guest1') == {'MICROPHONE'}
    assert admin.stop_camera('guest1') == 1
    assert admin.stop_screen_share('guest1') == 2
    assert livekit.muted('meet', 'guest1') == {'MICROPHONE', 'CAMERA', 'SCREEN_SHARE', 'SCREEN_SHARE_AUDIO'}
    assert admin.mute_all() == 1
    assert livekit.muted('meet', 'guest2') == {'MICROPHONE'}
    assert not livekit.muted('meet', 'speaker') and not livekit.muted('meet', me)
    admin.promote_to_presenter('guest2')
    assert livekit.participants['meet']['guest2'].attributes['gramlot.role'] == 'presenter'
    admin.request_unmute('guest1')
    sent = livekit.data[-1]
    assert (list(sent.destination_identities), sent.topic) == (['guest1'], 'gramlot.rtc')
    assert json.loads(sent.data) == {'kind': 'unmute-request'}
    assert sent.kind == models.DataPacket.Kind.RELIABLE
    admin.remove_participant('guest1')
    assert 'guest1' not in livekit.participants['meet']


def test_guest_cannot_call_livekit(livekit):
    admin = admin_in(livekit, 'meet')
    guest = RtcPageStore()
    guest.join(admin.rooms.create_invitation('meet', 'presenter', name='Pia'))
    livekit.add('meet', 'guest1', 'guest', 'MICROPHONE')
    calls = (guest.mute_all, guest.lobby_queue, lambda: guest.remove_participant('guest1'),
             lambda: guest.request_unmute('guest1'), lambda: guest.deny('guest1'))
    for call in calls:
        with pytest.raises(rtc.NotRoomAdmin):
            call()
    assert 'guest1' in livekit.participants['meet'] and not livekit.data


def test_guest_invitation_lock_state_and_own_actions_through_store_data(livekit):
    class StartingStore(RtcPageStore):
        def rtc_actions(self, request):
            actions = super().rtc_actions(request)
            actions['start'] = lambda: self.rooms.create_invitation(request.get_item('room'), 'admin', name='Root')
            return actions

    admin, guest = StartingStore(), RtcPageStore()
    admin.start()
    guest.start()
    try:
        request = requests_of(admin, [])
        refused = request('createInvitation')
        assert refused.get_item('accepted') is False and refused.get_item('error') == 'Only the room administrator can do this'
        invitation = request('start', room='weekly').get_item('value')
        assert admin.rooms.verify_invitation(invitation)['role'] == 'admin'
        assert request('join', invitation=invitation).get_item('value.status') == 'admitted'
        livekit.connect(dict(token=admin.rooms.issue_token('weekly', 'admin', name='Root', identity=admin.joined['identity'])))
        link = request('createInvitation').get_item('value')
        claims = admin.rooms.verify_invitation(link)
        assert (claims['room'], claims['role'], 'name' in claims) == ('weekly', 'guest', False)
        assert request('lock', locked=True).get_item('value') is True
        assert request('lock', locked=False).get_item('value') is False
        guest_request = requests_of(guest, [])
        assert guest_request('join', invitation=link, name='Ann').get_item('value.status') == 'admitted'
        assert guest_request('createInvitation').get_item('accepted') is False
    finally:
        admin.close()
        guest.close()


def test_rooms_status_verifies_each_invitation_and_counts_admitted_participants(livekit, monkeypatch):
    admin = admin_in(livekit, 'busy', admission='lobby')
    livekit.add('busy', 'g1', 'guest')
    livekit.add('busy', 'w1', 'guest')
    livekit.participants['busy']['w1'].attributes['gramlot.state'] = 'waiting'
    livekit.add('busy', 'j1', 'guest')
    livekit.participants['busy']['j1'].state = models.ParticipantInfo.State.JOINING
    store = RtcPageStore()
    busy = store.rooms.create_invitation('busy', 'admin')
    absent = store.rooms.create_invitation('absent', 'guest')
    short = store.rooms.create_invitation('busy', 'guest', expires_in=60)
    payload, signature = busy.split('.')
    tampered = rtc._b64encode(json.dumps(dict(room='busy', role='admin', exp=2 ** 40)).encode()) + '.' + signature
    now = rtc.time.time()
    monkeypatch.setattr(rtc.time, 'time', lambda: now + 61)
    entries = store.rooms.rooms_status([busy, absent, short, tampered, 'no-dot'])
    assert [entry['status'] for entry in entries] == ['valid', 'valid', 'expired', 'invalid', 'invalid']
    assert [entry['invitation'] for entry in entries] == [busy, absent, short, tampered, 'no-dot']
    assert (entries[0]['room'], entries[0]['role'], entries[0]['participants']) == ('busy', 'admin', 2)
    assert (entries[1]['room'], entries[1]['participants']) == ('absent', 0)
    assert entries[2]['room'] == 'busy' and 'participants' not in entries[2]
    assert entries[3] == dict(invitation=tampered, status='invalid')
    assert store.rooms.rooms_status([]) == []
    with pytest.raises(ValueError, match='At most 20'):
        store.rooms.rooms_status([busy] * 21)
    assert admin.joined['role'] == 'admin' and store.joined is None


def test_rooms_status_through_store_data(livekit):
    admin_in(livekit, 'weekly')
    store = RtcPageStore()
    store.start()
    try:
        request = requests_of(store, [])
        invitation = store.rooms.create_invitation('weekly', 'guest')
        response = request('roomsStatus', invitations=Bag(dict(i0=invitation, i1='bad.sig')))
        assert response.get_item('accepted') is True
        value = response.get_item('value')
        assert value.get_item('r0.status') == 'valid' and value.get_item('r0.participants') == 1
        assert value.get_item('r0.invitation') == invitation and value.get_item('r1.status') == 'invalid'
        refused = request('roomsStatus', invitations=Bag({f'i{n}': invitation for n in range(21)}))
        assert refused.get_item('accepted') is False and 'At most 20' in refused.get_item('error')
        assert request('roomsStatus').get_item('error') == 'invitations must be a list'
    finally:
        store.close()


def test_room_title_travels_in_invitations_join_and_rooms_status(livekit):
    admin = RtcPageStore()
    result = admin.join(admin.rooms.create_invitation('sales-1a2b', 'admin', name='Root', title=' Weekly sales '))
    assert result['title'] == 'Weekly sales'
    guest_invitation = admin.create_guest_invitation()
    assert admin.rooms.verify_invitation(guest_invitation)['title'] == 'Weekly sales'
    untitled = admin.rooms.create_invitation('plain', 'guest')
    entries = admin.rooms.rooms_status([guest_invitation, untitled])
    assert [entry['title'] for entry in entries] == ['Weekly sales', 'plain']
    with pytest.raises(ValueError, match='title'):
        admin.rooms.create_invitation('plain', 'guest', title=' ')
    with pytest.raises(ValueError, match='title'):
        admin.rooms.create_invitation('plain', 'guest', title='x' * (rtc.TITLE_MAX_LENGTH + 1))


def test_rooms_require_the_three_values(monkeypatch, credentials):
    with pytest.raises(ValueError, match='api_secret'):
        RtcRooms('http://127.0.0.1:9', KEY, '')
    rooms = RtcRooms.from_environment()
    assert rooms.livekit_url == 'http://127.0.0.1:9'
    monkeypatch.delenv('LIVEKIT_URL')
    with pytest.raises(RuntimeError, match='LIVEKIT_URL'):
        RtcRooms.from_environment()


def test_rooms_without_a_page_create_list_and_end_a_room(livekit):
    rooms = RtcRooms(livekit.url, KEY, SECRET)
    admin = rooms.create_invitation('review', 'admin', title='Review')
    guest = rooms.create_invitation('review', 'guest', title='Review')
    assert rooms.room_settings('review') is None
    rooms.create_room('review', admission='lobby')
    assert rooms.room_settings('review') == dict(admission='lobby', allowed=[], locked=False)
    livekit.add('review', 'g1', 'guest')
    assert [entry['participants'] for entry in rooms.rooms_status([admin, guest])] == [1, 1]
    rooms.end_room('review')
    assert 'review' not in livekit.rooms
    assert rooms.room_settings('review') is None


def test_end_meeting_closes_the_joined_room(livekit):
    admin = admin_in(livekit, 'closing')
    admin.end_meeting()
    assert 'closing' not in livekit.rooms


def test_room_operations_without_a_page(livekit):
    rooms = RtcRooms.from_environment()
    rooms.create_room('meet', admission='lobby')
    rooms.create_room('other')
    livekit.add('meet', 'host', 'admin', 'MICROPHONE')
    livekit.add('meet', 'guest1', 'guest', 'MICROPHONE', 'CAMERA')
    livekit.add('meet', 'speaker', 'presenter', 'MICROPHONE')
    waiting = livekit.participants['meet']['late'] = models.ParticipantInfo(
        identity='late', name='Late', state=models.ParticipantInfo.State.ACTIVE, joined_at=1000,
        attributes={'gramlot.role': 'guest', 'gramlot.state': 'waiting'})
    listing = {room.name: sorted(p.identity for p in participants) for room, participants in rooms.list_rooms()}
    assert listing == {'meet': ['guest1', 'host', 'late', 'speaker'], 'other': []}
    assert rooms.participant('meet', 'guest1').identity == 'guest1'
    assert rooms.lobby_queue('meet') == [dict(identity='late', name='Late', role='guest', since=1000)]
    rooms.admit('meet', 'late')
    assert waiting.attributes['gramlot.state'] == 'admitted' and waiting.permission.can_publish
    with pytest.raises(ValueError, match='No waiting participant late'):
        rooms.deny('meet', 'late')
    assert rooms.mute_all('meet', keep=['host']) == 1
    assert livekit.muted('meet', 'guest1') == {'MICROPHONE'} and not livekit.muted('meet', 'host')
    assert not livekit.muted('meet', 'speaker')
    assert rooms.stop_camera('meet', 'guest1') == 1
    assert rooms.lock_room('meet') is True
    assert livekit.settings('meet') == dict(admission='lobby', allowed=[], locked=True)
    rooms.remove_participant('meet', 'guest1')
    assert 'guest1' not in livekit.participants['meet']


def test_recordings_through_egress(livekit):
    rooms = RtcRooms.from_environment()
    rooms.create_room('meet')
    rooms.create_room('other')
    with pytest.raises(ValueError, match='filepath'):
        rooms.start_recording('meet', '')
    started = rooms.start_recording('meet', 'livekit/recordings/{room_name}-{time}.mp4')
    assert started.status == egress_proto.EgressStatus.EGRESS_ACTIVE
    request = livekit.egresses[started.egress_id].room_composite
    assert (request.room_name, request.layout) == ('meet', 'speaker')
    assert [(o.file_type, o.filepath) for o in request.file_outputs] == [
        (egress_proto.EncodedFileType.MP4, 'livekit/recordings/{room_name}-{time}.mp4')]
    other = rooms.start_recording('other', 'x.mp4', layout='grid')
    assert [e.egress_id for e in rooms.recordings(room='meet')] == [started.egress_id]
    assert rooms.stop_recording(started.egress_id).status == egress_proto.EgressStatus.EGRESS_ENDING
    assert [e.egress_id for e in rooms.recordings(active=True)] == [other.egress_id]
    assert len(rooms.recordings()) == 2
