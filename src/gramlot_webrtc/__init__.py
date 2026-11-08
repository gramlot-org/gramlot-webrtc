"""Gramlot WebRTC: the webrtc collection (LiveKit rooms in the browser) and its server side.

The collection descriptor is ``gramlot_webrtc.collections.webrtc.mygramlot``. ``RtcRooms`` works
without a page; ``RtcPageStore`` serves one page.
"""
from .page_store import RtcPageStore
from .rooms import (ADMISSIONS, ROLES, ROOMS_STATUS_LIMIT, TITLE_MAX_LENGTH, AdmissionRefused, InvitationExpired,
                    InvitationInvalid, NotRoomAdmin, RoomSettingsInvalid, RtcError, RtcRooms, checked_title)

__all__ = ['ADMISSIONS', 'ROLES', 'ROOMS_STATUS_LIMIT', 'TITLE_MAX_LENGTH', 'AdmissionRefused', 'InvitationExpired',
           'InvitationInvalid', 'NotRoomAdmin', 'RoomSettingsInvalid', 'RtcError', 'RtcPageStore', 'RtcRooms',
           'checked_title']
