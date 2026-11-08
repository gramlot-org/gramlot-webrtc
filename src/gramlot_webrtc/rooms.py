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

    # LiveKit server calls.

    def call_livekit(self, operation):
        """Run ``operation(room_service)``, a coroutine function, and return its result.

        The callers are synchronous; the call runs in its own event loop and thread.
        """
        async def run():
            async with api.LiveKitAPI(self.livekit_url, self._api_key, self._api_secret) as client:
                return await operation(client.room)

        with ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(asyncio.run, run()).result()
