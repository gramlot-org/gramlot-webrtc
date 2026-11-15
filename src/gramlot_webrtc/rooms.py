"""LiveKit rooms without a page: signed invitations, tokens, room settings and room state.

``RtcRooms`` holds the three LiveKit values and works without a PageStore. A REST or MCP
application uses it directly; ``RtcPageStore`` uses one for each page.
"""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import uuid4

from livekit import api

ROLES = ('admin', 'presenter', 'guest')
ADMISSIONS = ('link', 'list', 'lobby')
# Participant attributes and data topic shared with the webrtc collection in the browser.
# Only the server sets the attributes: tokens do not grant can_update_own_metadata.
ROLE_ATTRIBUTE = 'gramlot.role'
STATE_ATTRIBUTE = 'gramlot.state'
SIGNAL_TOPIC = 'gramlot.rtc'
_INVITATION_FIELDS = {'room', 'role', 'exp'}
_OPTIONAL_INVITATION_FIELDS = {'name', 'title'}
# The longest room title an invitation carries.
TITLE_MAX_LENGTH = 80
# The most invitations one rooms_status call checks.
ROOMS_STATUS_LIMIT = 20
_SETTING_FIELDS = {'admission', 'allowed', 'locked'}
_ENVIRONMENT = ('LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET')


class RtcError(Exception):
    """A refusal whose message the page or the API may show to the user."""


class InvitationInvalid(RtcError):
    """The invitation is malformed or its signature does not match."""


class InvitationExpired(RtcError):
    """The invitation is past its expiry."""


class AdmissionRefused(RtcError):
    """The room's admission rule or lock refuses the participant."""


class NotRoomAdmin(RtcError):
    """The page did not join the room with an administrator token."""


class RoomSettingsInvalid(RtcError):
    """The LiveKit room metadata is not a Gramlot room setting."""


def _b64encode(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def _b64decode(text):
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def checked_title(title):
    """Return ``title`` stripped; ValueError unless it is a nonempty string of at most ``TITLE_MAX_LENGTH``."""
    if not isinstance(title, str) or not title.strip() or len(title) > TITLE_MAX_LENGTH:
        raise ValueError(f'title must be a nonempty string of at most {TITLE_MAX_LENGTH} characters')
    return title.strip()


def checked_settings(admission, allowed, locked):
    """Return the room settings dict; ValueError when a value is not accepted."""
    if admission not in ADMISSIONS:
        raise ValueError(f'admission must be one of {ADMISSIONS}')
    if not isinstance(allowed, (list, tuple)) or not all(isinstance(n, str) and n for n in allowed):
        raise ValueError('allowed must be a list of nonempty names')
    if type(locked) is not bool:
        raise ValueError('locked must be true or false')
    return dict(admission=admission, allowed=list(allowed), locked=locked)


def settings_from_metadata(metadata):
    """The settings dict of a room metadata text; None for empty metadata."""
    if not metadata:
        return None
    try:
        settings = json.loads(metadata)
        if not isinstance(settings, dict) or settings.keys() != _SETTING_FIELDS:
            raise ValueError
        return checked_settings(settings['admission'], settings['allowed'], settings['locked'])
    except ValueError as error:
        raise RoomSettingsInvalid('The room metadata is not a Gramlot room setting') from error


class RtcRooms:
    """Access to the rooms of one LiveKit server.

    The object keeps no room state: the room settings (admission rule, allowed names, lock) are the
    JSON metadata of the LiveKit room, and the participants with their server-set attributes are
    read from LiveKit. Invitations are signed with the API secret.
    """

    token_ttl = 6 * 3600

    def __init__(self, url, api_key, api_secret):
        for name, value in (('url', url), ('api_key', api_key), ('api_secret', api_secret)):
            if not isinstance(value, str) or not value:
                raise ValueError(f'{name} must be a nonempty string')
        self.livekit_url = url
        self._api_key = api_key
        self._api_secret = api_secret

    @classmethod
    def from_environment(cls):
        """Build the object from ``LIVEKIT_URL``, ``LIVEKIT_API_KEY`` and ``LIVEKIT_API_SECRET``."""
        missing = [name for name in _ENVIRONMENT if not os.environ.get(name)]
        if missing:
            raise RuntimeError('RtcRooms requires the environment variables ' + ', '.join(missing))
        return cls(*(os.environ[name] for name in _ENVIRONMENT))

    # Invitations and tokens.

    def _signature(self, payload):
        return hmac.new(self._api_secret.encode('utf-8'), payload.encode('ascii'), hashlib.sha256).digest()

    def create_invitation(self, room, role, *, expires_in=86400, name=None, title=None):
        """Return a signed invitation for ``room`` and ``role``, valid ``expires_in`` seconds.

        ``title`` is the room title the page shows in place of the room name, at most ``TITLE_MAX_LENGTH``.
        """
        if not isinstance(room, str) or not room:
            raise ValueError('room must be a nonempty string')
        if role not in ROLES:
            raise ValueError(f'role must be one of {ROLES}')
        if type(expires_in) is not int or expires_in <= 0:
            raise ValueError('expires_in must be a positive number of seconds')
        claims = dict(room=room, role=role, exp=int(time.time()) + expires_in)
        if name is not None:
            if not isinstance(name, str) or not name:
                raise ValueError('name must be a nonempty string')
            claims['name'] = name
        if title is not None:
            claims['title'] = checked_title(title)
        payload = _b64encode(json.dumps(claims, separators=(',', ':'), sort_keys=True).encode('utf-8'))
        return payload + '.' + _b64encode(self._signature(payload))

    def verify_invitation(self, invitation):
        """Return the claims of a valid invitation: room, role, exp and the optional name and title."""
        claims = self._signed_claims(invitation)
        if claims['exp'] <= time.time():
            raise InvitationExpired('Invitation has expired')
        return claims

    def _signed_claims(self, invitation):
        """The claims of an invitation whose signature matches, without the expiry check."""
        if not isinstance(invitation, str) or invitation.count('.') != 1:
            raise InvitationInvalid('Malformed invitation')
        payload, signature = invitation.split('.')
        try:
            given = _b64decode(signature)
            payload.encode('ascii')
        except (ValueError, UnicodeError) as error:
            raise InvitationInvalid('Malformed invitation') from error
        if not hmac.compare_digest(self._signature(payload), given):
            raise InvitationInvalid('Invitation signature does not match')
        claims = json.loads(_b64decode(payload))
        if (not isinstance(claims, dict) or not _INVITATION_FIELDS <= claims.keys() <= _INVITATION_FIELDS | _OPTIONAL_INVITATION_FIELDS
                or claims['role'] not in ROLES or type(claims['exp']) is not int):
            raise InvitationInvalid('Malformed invitation')
        return claims

    def issue_token(self, room, role, *, name, identity=None, waiting=False):
        """Return a LiveKit join token; ``identity`` defaults to a new unique identity.

        The token sets the attributes ``gramlot.role`` and ``gramlot.state`` (admitted, or waiting
        when ``waiting``). A waiting token connects but can neither publish, subscribe nor send data.
        """
        if role not in ROLES:
            raise ValueError(f'role must be one of {ROLES}')
        if not isinstance(name, str) or not name:
            raise ValueError('name must be a nonempty string')
        if waiting and role == 'admin':
            raise ValueError('An administrator never waits')
        allowed = not waiting
        grants = api.VideoGrants(room_join=True, room=room, room_admin=role == 'admin',
                                 can_publish=allowed, can_subscribe=allowed, can_publish_data=allowed)
        attributes = {ROLE_ATTRIBUTE: role, STATE_ATTRIBUTE: 'waiting' if waiting else 'admitted'}
        return (api.AccessToken(self._api_key, self._api_secret)
                .with_identity(identity or uuid4().hex).with_name(name)
                .with_ttl(timedelta(seconds=self.token_ttl))
                .with_attributes(attributes).with_grants(grants).to_jwt())

    # Room state.

    def rooms_status(self, invitations):
        """The state of the room of each invitation, in the given order, at most ``ROOMS_STATUS_LIMIT``.

        Each entry holds ``invitation`` and ``status``: ``invalid`` (malformed or bad signature, nothing
        else is told), ``expired`` or ``valid``, the last two with the signed ``room``, ``role``,
        ``exp`` and ``title`` (the room when the invitation has none). A valid entry also holds
        ``participants``: the admitted participants in the room, joined or active, read from LiveKit;
        0 when the room does not exist.
        """
        if not isinstance(invitations, (list, tuple)):
            raise ValueError('invitations must be a list')
        if len(invitations) > ROOMS_STATUS_LIMIT:
            raise ValueError(f'At most {ROOMS_STATUS_LIMIT} invitations')
        entries = []
        for invitation in invitations:
            try:
                claims = self._signed_claims(invitation)
            except InvitationInvalid:
                entries.append(dict(invitation=invitation, status='invalid'))
                continue
            entries.append(dict(invitation=invitation, status='expired' if claims['exp'] <= time.time() else 'valid',
                                room=claims['room'], role=claims['role'], exp=claims['exp'],
                                title=claims.get('title') or claims['room']))
        rooms = sorted({entry['room'] for entry in entries if entry['status'] == 'valid'})
        if rooms:
            counts = self._admitted_counts(rooms)
            for entry in entries:
                if entry['status'] == 'valid':
                    entry['participants'] = counts.get(entry['room'], 0)
        return entries

    def _admitted_counts(self, rooms):
        """The number of admitted participants, joined or active, of each existing room of ``rooms``."""
        present = {api.ParticipantInfo.State.JOINED, api.ParticipantInfo.State.ACTIVE}

        async def read(service):
            existing = (await service.list_rooms(api.ListRoomsRequest(names=rooms))).rooms
            counts = {}
            for room in existing:
                participants = (await service.list_participants(
                    api.ListParticipantsRequest(room=room.name))).participants
                counts[room.name] = sum(1 for p in participants if p.state in present
                                        and p.attributes.get(STATE_ATTRIBUTE) != 'waiting')
            return counts
        return self.call_livekit(read)

    def room_presence(self, room):
        """Return the metadata of ``room`` (None when absent) and whether an administrator is in it."""
        present = {api.ParticipantInfo.State.JOINED, api.ParticipantInfo.State.ACTIVE}

        async def read(service):
            rooms = (await service.list_rooms(api.ListRoomsRequest(names=[room]))).rooms
            if not rooms:
                return None, False
            participants = (await service.list_participants(api.ListParticipantsRequest(room=room))).participants
            return rooms[0].metadata, any(p.attributes.get(ROLE_ATTRIBUTE) == 'admin' and p.state in present
                                          for p in participants)
        return self.call_livekit(read)

    # Room settings: the JSON metadata of the LiveKit room.

    def room_settings(self, room):
        """The settings of ``room`` read from LiveKit; None when the room or its settings are absent."""
        async def read(service):
            rooms = (await service.list_rooms(api.ListRoomsRequest(names=[room]))).rooms
            return rooms[0].metadata if rooms else ''
        return settings_from_metadata(self.call_livekit(read))

    def create_room(self, room, *, admission='link', allowed=(), locked=False):
        """Create the LiveKit ``room`` with these settings, or write them into the existing room."""
        if not isinstance(room, str) or not room:
            raise ValueError('room must be a nonempty string')
        metadata = json.dumps(checked_settings(admission, allowed, locked), separators=(',', ':'))

        async def write(service):
            if (await service.list_rooms(api.ListRoomsRequest(names=[room]))).rooms:
                await service.update_room_metadata(api.UpdateRoomMetadataRequest(room=room, metadata=metadata))
            else:
                await service.create_room(api.CreateRoomRequest(name=room, metadata=metadata))
        self.call_livekit(write)

    def end_room(self, room):
        """Close ``room`` for everyone: LiveKit disconnects every participant."""
        self.call_livekit(lambda service: service.delete_room(api.DeleteRoomRequest(room=room)))

    def configure_room(self, room, *, admission=None, allowed=None, locked=None):
        """Change the given settings of ``room``; the others keep their value."""
        changes = {key: value for key, value in dict(admission=admission, allowed=allowed, locked=locked).items()
                   if value is not None}
        self.create_room(room, **{**(self.room_settings(room) or {}), **changes})

    def lock_room(self, room, locked=True):
        """Lock or unlock ``room`` and return the new lock state.

        A locked room admits no new participant except administrators."""
        self.configure_room(room, locked=bool(locked))
        return bool(locked)

    # Rooms and participants of the whole server.

    def list_rooms(self):
        """Every room of the server with its participants, read in one LiveKit connection.

        Returns a list of ``(room, participants)``: a LiveKit Room record and the list of its
        ParticipantInfo records.
        """
        async def read(service):
            rooms = (await service.list_rooms(api.ListRoomsRequest())).rooms
            return [(room, list((await service.list_participants(
                api.ListParticipantsRequest(room=room.name))).participants)) for room in rooms]
        return self.call_livekit(read)

    def participants(self, room):
        """The participants of ``room`` as LiveKit ParticipantInfo records."""
        async def listing(service):
            return list((await service.list_participants(api.ListParticipantsRequest(room=room))).participants)
        return self.call_livekit(listing)

    def participant(self, room, identity):
        """The LiveKit ParticipantInfo of ``identity`` in ``room``."""
        return self.call_livekit(lambda service: service.get_participant(
            api.RoomParticipantIdentity(room=room, identity=identity)))

    # Lobby.

    def lobby_queue(self, room):
        """The participants waiting in ``room``: identity, name, role and since (Unix seconds)."""
        return [dict(identity=p.identity, name=p.name, role=p.attributes.get(ROLE_ATTRIBUTE), since=p.joined_at)
                for p in self.participants(room) if p.attributes.get(STATE_ATTRIBUTE) == 'waiting']

    @staticmethod
    async def _waiting_participant(service, room, identity):
        """The ParticipantInfo of a waiting participant of ``room``; ValueError when there is none."""
        participants = (await service.list_participants(api.ListParticipantsRequest(room=room))).participants
        for participant in participants:
            if participant.identity == identity and participant.attributes.get(STATE_ATTRIBUTE) == 'waiting':
                return participant
        raise ValueError(f'No waiting participant {identity}')

    def admit(self, room, identity):
        """Give a waiting participant publish, subscribe and data permissions and the state admitted."""
        async def admit(service):
            await self._waiting_participant(service, room, identity)
            await service.update_participant(api.UpdateParticipantRequest(
                room=room, identity=identity, attributes={STATE_ATTRIBUTE: 'admitted'},
                permission=api.ParticipantPermission(can_publish=True, can_subscribe=True, can_publish_data=True)))
        self.call_livekit(admit)

    def admit_all(self, room):
        """Admit every participant waiting in ``room``."""
        for entry in self.lobby_queue(room):
            self.admit(room, entry['identity'])

    def deny(self, room, identity):
        """Remove a waiting participant from ``room``."""
        async def deny(service):
            await self._waiting_participant(service, room, identity)
            await service.remove_participant(api.RoomParticipantIdentity(room=room, identity=identity))
        self.call_livekit(deny)

    # Participants. The server mutes and never unmutes: an unmute is a request the participant answers.

    def mute_sources(self, room, identities, sources):
        """Mute the published tracks of ``sources`` for each identity; return the muted track count."""
        async def mute(service):
            muted = 0
            for identity in identities:
                participant = await service.get_participant(
                    api.RoomParticipantIdentity(room=room, identity=identity))
                for track in participant.tracks:
                    if track.source in sources and not track.muted:
                        await service.mute_published_track(api.MuteRoomTrackRequest(
                            room=room, identity=identity, track_sid=track.sid, muted=True))
                        muted += 1
            return muted
        return self.call_livekit(mute)

    def mute_microphone(self, room, identity):
        return self.mute_sources(room, [identity], {api.TrackSource.MICROPHONE})

    def stop_camera(self, room, identity):
        return self.mute_sources(room, [identity], {api.TrackSource.CAMERA})

    def stop_screen_share(self, room, identity):
        return self.mute_sources(room, [identity], {api.TrackSource.SCREEN_SHARE, api.TrackSource.SCREEN_SHARE_AUDIO})

    def mute_all(self, room, *, keep=()):
        """Mute every microphone of ``room`` except those of presenters and of the identities in ``keep``."""
        identities = [p.identity for p in self.participants(room)
                      if p.identity not in keep and p.attributes.get(ROLE_ATTRIBUTE) != 'presenter']
        return self.mute_sources(room, identities, {api.TrackSource.MICROPHONE})

    def remove_participant(self, room, identity):
        self.call_livekit(lambda service: service.remove_participant(
            api.RoomParticipantIdentity(room=room, identity=identity)))

    def promote_to_presenter(self, room, identity):
        self.call_livekit(lambda service: service.update_participant(api.UpdateParticipantRequest(
            room=room, identity=identity, attributes={ROLE_ATTRIBUTE: 'presenter'})))

    def request_unmute(self, room, identity):
        """Send ``{"kind": "unmute-request"}`` on topic gramlot.rtc to ``identity`` only."""
        data = json.dumps({'kind': 'unmute-request'}).encode('utf-8')
        self.call_livekit(lambda service: service.send_data(api.SendDataRequest(
            room=room, data=data, kind=api.DataPacket.Kind.RELIABLE,
            destination_identities=[identity], topic=SIGNAL_TOPIC)))

    # Recordings: LiveKit Egress. The egress worker writes the file to the storage of its own configuration.

    def start_recording(self, room, filepath, *, layout='speaker'):
        """Start a composite recording of ``room`` to an MP4 file and return its LiveKit EgressInfo.

        ``filepath`` is the file path in the egress storage; LiveKit replaces ``{room_name}`` and
        ``{time}`` in it. ``layout`` is a LiveKit composite layout (``speaker``, ``grid``, ...).
        """
        if not isinstance(filepath, str) or not filepath:
            raise ValueError('filepath must be a nonempty string')
        output = api.EncodedFileOutput(file_type=api.EncodedFileType.MP4, filepath=filepath)
        return self.call_livekit(lambda service: service.start_room_composite_egress(
            api.RoomCompositeEgressRequest(room_name=room, layout=layout, file_outputs=[output])), service='egress')

    def stop_recording(self, egress_id):
        """Stop the recording ``egress_id`` and return its LiveKit EgressInfo."""
        return self.call_livekit(lambda service: service.stop_egress(api.StopEgressRequest(egress_id=egress_id)),
                                 service='egress')

    def recordings(self, *, room=None, active=False):
        """The LiveKit EgressInfo records of the server, of ``room`` when given, only the active ones when ``active``."""
        request = api.ListEgressRequest(room_name=room or '', active=active)
        return list(self.call_livekit(lambda service: service.list_egress(request), service='egress').items)

    # LiveKit server calls.

    def call_livekit(self, operation, *, service='room'):
        """Run ``operation(client_service)``, a coroutine function, and return its result.

        ``service`` is the attribute of ``livekit.api.LiveKitAPI`` passed to ``operation``: ``room``
        (RoomService) or ``egress``. The callers are synchronous; the call runs in its own event loop
        and thread.
        """
        async def run():
            async with api.LiveKitAPI(self.livekit_url, self._api_key, self._api_secret) as client:
                return await operation(getattr(client, service))

        with ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(asyncio.run, run()).result()
