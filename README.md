# gramlot-webrtc

The `webrtc` collection of [Gramlot](https://github.com/gramlot-org/gramlot): video meetings on
[LiveKit](https://livekit.io/) in a Gramlot page, with the server side that issues invitations and
tokens.

The package has three parts:

- the collection `webrtc`, with the components `rtcRoom`, `rtcTile` and `rtcAnnotations`; it
  depends on the core collection `drawing` and bundles `livekit-client`, loaded on first connection;
- `RtcRooms`, the room operations that need no page: signed invitations, join tokens, room
  settings, room state and room closing;
- `RtcPageStore`, the PageStore of one meeting page: admission, lobby and administrator calls.

## Install

```bash
pip install gramlot-webrtc
```

The LiveKit server is configured by three values: `LIVEKIT_URL`, `LIVEKIT_API_KEY` and
`LIVEKIT_API_SECRET`.

## Activate the collection

The collection descriptor is `gramlot_webrtc.collections.webrtc.mygramlot`. A page selects it in
`gramlots`, or a host application passes it in its `collections` option:

```python
from gramlot_webrtc.collections.webrtc import mygramlot as webrtc

class MeetingPage(Page):
    gramlots = [webrtc]
```

Selecting `webrtc` also selects `drawing`.

The collection module exports `rtcAvatarAllowed` and `rtcAvatarMaxLength` for the page logic of an
application.

## Room operations without a page

```python
from gramlot_webrtc import RtcRooms

rooms = RtcRooms.from_environment()          # or RtcRooms(url, api_key, api_secret)
admin = rooms.create_invitation('room-1', 'admin', title='Weekly review')
guest = rooms.create_invitation('room-1', 'guest', title='Weekly review')
rooms.rooms_status([admin, guest])
rooms.end_room('room-1')
```

`RtcError` is the base of every refusal whose message may be shown to the user.
`TITLE_MAX_LENGTH` is the longest room title; `checked_title(title)` validates one.

## Page store actions

The page writes `rtc.request`, a Bag with `id`, `action` and the action parameters. The store
writes `rtc.response` with `id`, `action`, `accepted`, `error` and `value`.

An application adds its own actions by extending `rtc_actions`:

```python
from gramlot_webrtc import RtcPageStore

class MeetingStore(RtcPageStore):
    def rtc_actions(self, request):
        actions = super().rtc_actions(request)
        actions['create'] = lambda: self.create_meeting(request.get_item('description'))
        return actions
```

The value an action returns is written in `rtc.response.value`; a dict becomes a Bag. An
`RtcError` or `ValueError` it raises is a refusal: its message is written in `rtc.response.error`.

## Development

The collection is prepared with `gramlot-builder`, from the `gramlot` package:

```bash
npm install
npm run build
```

`npm run build` regenerates `src/gramlot_webrtc/collections/webrtc`. The builder needs the
project-local npm packages `@gramlot/gramlot` and `@gramlot/builder`.

Tests:

```bash
pytest
npm test
```
