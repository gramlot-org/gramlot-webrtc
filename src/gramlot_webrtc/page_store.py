"""One page's access to LiveKit rooms: admission, lobby and administrator calls, page requests.

The room operations that need no page live in ``RtcRooms``; this store holds one in ``rooms``.
"""
from uuid import uuid4

from genro_bag import Bag
from gramlot import PageStore

from .rooms import AdmissionRefused, NotRoomAdmin, RtcError, RtcRooms, settings_from_metadata


class RtcPageStore(PageStore):
    """One page's access to LiveKit rooms.

    ``rooms`` is the ``RtcRooms`` built from ``LIVEKIT_URL``, ``LIVEKIT_API_KEY`` and
    ``LIVEKIT_API_SECRET``. The role of the page is the role of the token it obtained through
    ``join``, kept in ``joined``: administrator calls require that this page joined the room as
    ``admin``.

    The page sends requests by writing ``rtc.request`` (a Bag with ``id``, ``action`` and the
    action parameters); the store answers in ``rtc.response``. ``rtc_actions`` is the extension
    point for the actions of an application page store.
    """

    def __init__(self):
        super().__init__()
        self.rooms = RtcRooms.from_environment()
        self.joined = None

    # Admission.

    def _admitted(self, room, role, name, title, *, waiting=False):
        identity = uuid4().hex
        token = self.rooms.issue_token(room, role, name=name, identity=identity, waiting=waiting)
        self.joined = dict(room=room, role=role, identity=identity, name=name, title=title)
        return dict(status='waiting' if waiting else 'admitted', url=self.rooms.livekit_url, token=token,
                    room=room, role=role, identity=identity, name=name, title=title)

    def join(self, invitation, *, name=None, admission=None, allowed=None, locked=None):
        """Apply the room's admission rule to an invitation.

        Returns ``status`` ``admitted`` with url and token; ``waiting`` with a waiting token in a
        lobby room; ``waitingForAdmin`` when no administrator is in the room, and the page sends
        ``join`` again later. An ``admin`` invitation always enters: it creates the LiveKit room
        when absent and writes ``admission``, ``allowed`` and ``locked`` when given. The display
        name is the invitation's name, else ``name``. Every answer holds ``title``: the invitation's
        title, else the room.
        """
        if self.joined is not None:
            raise RuntimeError('This page has already joined')
        claims = self.rooms.verify_invitation(invitation)
        room, role = claims['room'], claims['role']
        title = claims.get('title') or room
        display = claims.get('name') or name
        if not isinstance(display, str) or not display.strip():
            raise ValueError('A display name is required')
        changes = {key: value for key, value in dict(admission=admission, allowed=allowed, locked=locked).items()
                   if value is not None}
        if role == 'admin':
            current = self.rooms.room_settings(room)
            if current is None or changes:
                self.rooms.create_room(room, **{**(current or {}), **changes})
            return self._admitted(room, role, display, title)
        if changes:
            raise NotRoomAdmin('Only the room administrator can change the room settings')
        metadata, admin_present = self.rooms.room_presence(room)
        settings = settings_from_metadata(metadata)
        if settings is None:
            return dict(status='waitingForAdmin', room=room, role=role, name=display, title=title)
        if settings['locked']:
            raise AdmissionRefused('The room is locked')
        if settings['admission'] == 'list' and claims.get('name') not in settings['allowed']:
            raise AdmissionRefused('You are not on the list of this room')
        if not admin_present:
            return dict(status='waitingForAdmin', room=room, role=role, name=display, title=title)
        return self._admitted(room, role, display, title, waiting=settings['admission'] == 'lobby')

    # Administrator: room settings and lobby.

    def require_admin(self):
        """Return the joined room when this page joined it as admin."""
        if self.joined is None or self.joined['role'] != 'admin':
            raise NotRoomAdmin('Only the room administrator can do this')
        return self.joined['room']

    def configure_room(self, *, admission=None, allowed=None, locked=None):
        """Change the given settings of the joined room; the others keep their value."""
        self.rooms.configure_room(self.require_admin(), admission=admission, allowed=allowed, locked=locked)

    def lock_room(self, locked=True):
        """Lock or unlock the joined room and return the new lock state."""
        return self.rooms.lock_room(self.require_admin(), locked)

    def create_guest_invitation(self, *, expires_in=86400):
        """Return a guest invitation for the joined room with its title; only its administrator may create one."""
        room = self.require_admin()
        title = self.joined['title']
        return self.rooms.create_invitation(room, 'guest', expires_in=expires_in,
                                            title=None if title == room else title)

    def lobby_queue(self):
        """The participants waiting in the joined room: identity, name, role and since (Unix seconds)."""
        return self.rooms.lobby_queue(self.require_admin())

    def admit(self, identity):
        self.rooms.admit(self.require_admin(), identity)

    def admit_all(self):
        self.rooms.admit_all(self.require_admin())

    def deny(self, identity):
        self.rooms.deny(self.require_admin(), identity)

    # Administrator: participants. The room operations are those of RtcRooms on the joined room.

    def mute_microphone(self, identity):
        return self.rooms.mute_microphone(self.require_admin(), identity)

    def stop_camera(self, identity):
        return self.rooms.stop_camera(self.require_admin(), identity)

    def stop_screen_share(self, identity):
        return self.rooms.stop_screen_share(self.require_admin(), identity)

    def participants(self):
        """The participants of the joined room as LiveKit ParticipantInfo records."""
        return self.rooms.participants(self.require_admin())

    def mute_all(self):
        """Mute every microphone except the caller's and those of presenters."""
        return self.rooms.mute_all(self.require_admin(), keep=[self.joined['identity']])

    def end_meeting(self):
        """Close the joined room for everyone: LiveKit disconnects every participant."""
        self.rooms.end_room(self.require_admin())

    def remove_participant(self, identity):
        self.rooms.remove_participant(self.require_admin(), identity)

    def promote_to_presenter(self, identity):
        self.rooms.promote_to_presenter(self.require_admin(), identity)

    def request_unmute(self, identity):
        """Send ``{"kind": "unmute-request"}`` on topic gramlot.rtc to ``identity`` only."""
        self.rooms.request_unmute(self.require_admin(), identity)

    # Page requests through the store Data.

    def main(self, root):
        root.dataSetter('rtc', Bag(dict(request=None, response=None)))
        root.dataController(func='rtc_request', request='^rtc.request')

    @staticmethod
    def request_values(request, name):
        """A list parameter of a request: a Bag whose values are the items, or None."""
        items = request.get_item(name)
        return None if items is None else list(items.values()) if isinstance(items, Bag) else items

    def rtc_actions(self, request):
        """The page actions as a dict of name to a callable without arguments that reads ``request``.

        Extension point: an application page store adds its own actions by extending the dict
        returned by ``super().rtc_actions(request)``. ``request`` is the Bag the page wrote in
        ``rtc.request``; ``request.get_item(name)`` reads a parameter and ``request_values`` reads a
        list parameter. The value the callable returns is written in ``rtc.response.value``; a dict
        becomes a Bag. An ``RtcError`` or ``ValueError`` it raises is a refusal: its message is
        written in ``rtc.response.error`` for the page to show.
        """
        return dict(
            join=lambda: self.join(request.get_item('invitation'), name=request.get_item('name'),
                                   admission=request.get_item('admission'),
                                   allowed=self.request_values(request, 'allowed'),
                                   locked=request.get_item('locked')),
            configure=lambda: self.configure_room(admission=request.get_item('admission'),
                                                  allowed=self.request_values(request, 'allowed'),
                                                  locked=request.get_item('locked')),
            lobbyQueue=lambda: Bag({entry['identity']: Bag(entry) for entry in self.lobby_queue()}),
            admit=lambda: self.admit(request.get_item('identity')),
            admitAll=self.admit_all,
            deny=lambda: self.deny(request.get_item('identity')),
            lock=lambda: self.lock_room(request.get_item('locked') is True),
            mute=lambda: self.mute_microphone(request.get_item('identity')),
            muteAll=self.mute_all,
            stopCamera=lambda: self.stop_camera(request.get_item('identity')),
            stopScreenShare=lambda: self.stop_screen_share(request.get_item('identity')),
            remove=lambda: self.remove_participant(request.get_item('identity')),
            promote=lambda: self.promote_to_presenter(request.get_item('identity')),
            unmuteRequest=lambda: self.request_unmute(request.get_item('identity')),
            createInvitation=self.create_guest_invitation,
            endMeeting=self.end_meeting,
            roomsStatus=lambda: Bag({f'r{index}': Bag(entry) for index, entry in
                                     enumerate(self.rooms.rooms_status(self.request_values(request, 'invitations')))}),
        )

    def rtc_request(self, node, request):
        """Run the action of ``rtc.request`` and write ``rtc.response``: id, action, accepted, error, value."""
        if not isinstance(request, Bag):
            return
        request_id, action = request.get_item('id'), request.get_item('action')
        if not isinstance(request_id, str) or not request_id:
            raise ValueError('RTC requests require an ID')
        previous = self.data.get_item('rtc.response')
        if isinstance(previous, Bag) and previous.get_item('id') == request_id:
            return
        actions = self.rtc_actions(request)
        value, accepted, error = None, False, ''
        try:
            if action not in actions:
                raise RtcError(f'Unknown RTC action: {action}')
            value = actions[action]()
            accepted = True
        except (RtcError, ValueError) as refusal:
            error = str(refusal)
        except Exception:
            error = 'The server could not complete the request.'
        self.data.set_item('rtc.response', Bag(dict(id=request_id, action=action, accepted=accepted,
                                                    error=error, value=Bag(value) if isinstance(value, dict) else value)))
