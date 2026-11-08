import test from 'node:test';
import assert from 'node:assert/strict';
import {rtcAvatarAllowed, rtcAvatarMaxLength} from '../src/rtc-room-session.js';
import {rtcInitials, rtcInitialsColor} from '../src/webrtc.js';

test('an avatar is a JPEG, PNG or WebP data URL within rtcAvatarMaxLength', () => {
    assert.equal(rtcAvatarAllowed('data:image/jpeg;base64,/9j/4AAQ=='), true);
    assert.equal(rtcAvatarAllowed('data:image/webp;base64,UklGRg'), true);
    assert.equal(rtcAvatarAllowed('data:image/svg+xml;base64,PHN2Zz4='), false);
    assert.equal(rtcAvatarAllowed('https://example.com/a.png'), false);
    assert.equal(rtcAvatarAllowed('data:image/png;base64,' + 'A'.repeat(rtcAvatarMaxLength)), false);
    assert.equal(rtcAvatarAllowed(null), false);
});

test('initials take the first letter of the first two words; the color depends only on the identity', () => {
    assert.equal(rtcInitials('ada  lovelace byron'), 'AL');
    assert.equal(rtcInitials('élodie'), 'É');
    assert.equal(rtcInitials(''), '');
    assert.equal(rtcInitialsColor('id-1'), rtcInitialsColor('id-1'));
    assert.match(rtcInitialsColor('id-1'), /^hsl\(\d+ 45% 42%\)$/);
});
