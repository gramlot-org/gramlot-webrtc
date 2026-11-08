/** LiveKit room connection and local media; independent of Data and of the participant grid. */
let loading;

/** Room options: adaptive stream and dynacast, simulcast on every published video. */
export const rtcRoomOptions = Object.freeze({adaptiveStream:true,dynacast:true,publishDefaults:{simulcast:true}});

const MEDIA = {
    microphone:{method:'setMicrophoneEnabled',source:'microphone',label:'Microphone'},
    camera:{method:'setCameraEnabled',source:'camera',label:'Camera'},
    screen:{method:'setScreenShareEnabled',source:'screen_share',label:'Screen sharing'}
};
export const rtcMediaKinds = Object.freeze(Object.keys(MEDIA));

/** Topic of the LiveKit data messages of the rtc collection: UTF-8 JSON objects with a `kind` field. */
export const rtcDataTopic = 'gramlot.rtc';
/** Participant attributes set only by the server (RtcPageStore): role admin|presenter|guest, state waiting|admitted. */
export const rtcRoleAttribute = 'gramlot.role';
export const rtcStateAttribute = 'gramlot.state';
/** Device parameters of rtcRoom and their MediaDeviceInfo kinds. */
export const rtcDevices = Object.freeze({audioInput:'audioinput',videoInput:'videoinput',audioOutput:'audiooutput'});
/** The longest avatar image accepted, in characters of its data URL: the {kind:'avatar'} message stays one reliable data packet. */
export const rtcAvatarMaxLength = 12000;
const AVATAR_URL=/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;

/** True for an avatar image the room accepts: a JPEG, PNG or WebP data URL of at most rtcAvatarMaxLength characters. */
export function rtcAvatarAllowed(image) {
    return typeof image==='string'&&image.length<=rtcAvatarMaxLength&&AVATAR_URL.test(image);
}

/** The message written to `error` for a failed local media change. */
export function rtcMediaError(kind,error) {
    const {label}=MEDIA[kind];
    if(error?.name==='NotAllowedError')return new Error(`${label} permission denied`);
    if(error?.name==='NotFoundError')return new Error(`${label} device not found`);
    return new Error(`${label} failed: ${error.message}`);
}

const unit=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const SHAPES={
    arrow:shape=>unit(shape.x)&&unit(shape.y)&&unit(shape.x2)&&unit(shape.y2),
    circle:shape=>unit(shape.x)&&unit(shape.y)&&finite(shape.radius)&&shape.radius>=0,
    freehand:shape=>Array.isArray(shape.points)&&shape.points.length>0&&shape.points.every(p=>Array.isArray(p)&&unit(p[0])&&unit(p[1])),
    text:shape=>unit(shape.x)&&unit(shape.y)&&typeof shape.text==='string'&&shape.text.length>0
};
/** Annotation message kinds on a screen share: pointer travels lossy, the others reliable. */
export const rtcAnnotationKinds = Object.freeze(['pointer','stroke','stroke-delete','strokes-clear','draw-lock']);

/**
 * Whether an annotation message from `identity` is well formed and allowed: coordinates are 0..1 of the shared image;
 * only the sharer deletes a shape of its share; only the host (admin) clears shapes or locks drawing.
 */
export function rtcAnnotationAllowed(message,identity,host) {
    const share=typeof message?.share==='string'&&message.share!=='';
    const id=typeof message?.id==='string'&&/^[A-Za-z0-9_]{1,64}$/.test(message.id);
    switch(message?.kind) {
        case 'pointer':return share&&unit(message.x)&&unit(message.y);
        case 'stroke':{const shape=message.shape;return share&&id&&shape!==null&&typeof shape==='object'
            &&Object.hasOwn(SHAPES,shape.type)&&SHAPES[shape.type](shape)&&typeof shape.color==='string'&&finite(shape.width);}
        case 'stroke-delete':return share&&message.share===identity&&id;
        case 'strokes-clear':return share&&host;
        case 'draw-lock':return host&&typeof message.locked==='boolean';
        default:return false;
    }
}

const visible=publication=>publication?.track && !publication.isMuted ? publication.track : null;

export class RtcRoomSession {
    #window; #events; #generation=0; #room=null; #livekit=null; #connected=false;
    #media={microphone:false,camera:false,screen:false}; #hand=false; #hands=new Set(); #avatar=null; #avatars=new Map();
    /**
     * `events` receives the session reports: state(status), error(error), changed(), mediaEnded(kind),
     * received(message,identity), canPublish(flag), devices(lists), activeDevice(name,deviceId).
     */
    constructor(window,events) { this.#window=window;this.#events=events; }
    get connected() { return this.#connected; }
    /** Identity of the local participant; null when not connected. */
    get identity() { return this.#connected ? this.#room.localParticipant.identity : null; }
    /** Publish permission of the local participant: false for a waiting (lobby) token; null when not connected. */
    get canPublish() { return this.#connected ? Boolean(this.#room.localParticipant.permissions?.canPublish) : null; }
    /** Load LiveKit on first use, then join the room; local media follows with setMedia. */
    async connect(url,token) {
        const win=this.#window;
        if(!win.isSecureContext||!win.navigator.mediaDevices?.getUserMedia)throw new Error('RTC rooms require HTTPS or localhost and media device support');
        if(!url||!token)throw new Error('RTC room requires url and token');
        const generation=++this.#generation;
        this.#events.state('connecting');
        const livekit=await (loading ??= import('livekit-client'));
        if(generation!==this.#generation)return;
        const room=new livekit.Room(rtcRoomOptions);
        this.#livekit=livekit;this.#room=room;
        this.#listen(room,livekit);
        try { await room.connect(url,token); }
        catch(error) {
            if(generation!==this.#generation)return;
            await this.disconnect();throw error;
        }
        if(generation!==this.#generation)return;
        this.#connected=true;
        this.#events.state('connected');
        this.#events.canPublish(this.canPublish);
        this.#changed();
        void this.#listDevices(room);
    }
    /** Leave the room and stop every local track. */
    async disconnect() {
        const generation=++this.#generation;
        const room=this.#room;
        this.#room=null;this.#connected=false;this.#media={microphone:false,camera:false,screen:false};
        this.#hand=false;this.#hands.clear();this.#avatar=null;this.#avatars.clear();
        if(room) {room.removeAllListeners();await room.disconnect(true);}
        if(generation===this.#generation){this.#events.state('disconnected');this.#events.changed();}
    }
    /**
     * Apply one local media flag. The LiveKit call starts synchronously, so a screen share requested
     * inside a click reaches getDisplayMedia within that user activation. Returns null when nothing changes,
     * and while the participant may not publish (lobby): the request waits for the permission.
     */
    setMedia(kind,enabled) {
        if(!this.#connected||!this.canPublish||this.#media[kind]===enabled)return null;
        this.#media[kind]=enabled;
        const room=this.#room;
        return room.localParticipant[MEDIA[kind].method](enabled).then(()=>undefined,error=>{
            if(this.#room===room)this.#media[kind]=false;
            throw rtcMediaError(kind,error);
        });
    }
    /**
     * Raise or lower the local hand: the data message {kind:'hand',raised} goes to every participant.
     * Participants cannot write their own attributes, so the hand is not an attribute. Returns null when nothing changes.
     */
    setHand(raised) {
        if(!this.#connected||this.#hand===raised)return null;
        if(!this.#room.localParticipant.permissions?.canPublishData)return Promise.reject(new Error('Raise hand needs the data permission'));
        this.#hand=raised;this.#changed();
        const room=this.#room;
        return this.send({kind:'hand',raised}).catch(error=>{
            if(this.#room===room){this.#hand=false;this.#changed();}
            throw new Error(`Raise hand failed: ${error.message}`);
        });
    }
    /** Send one data message on the topic gramlot.rtc, to every participant or to the given identities; reliable=false sends it lossy. */
    /**
     * Set the local avatar image (rtcAvatarAllowed) or null: {kind:'avatar',image} goes to every participant.
     * Returns null when nothing changes or while the participant may not send data (lobby).
     */
    setAvatar(image) {
        if(image!==null&&!rtcAvatarAllowed(image))throw new TypeError('rtcRoom avatar must be a JPEG, PNG or WebP data URL');
        if(!this.#connected||!this.#room.localParticipant.permissions?.canPublishData||this.#avatar===image)return null;
        this.#avatar=image;
        this.#changed();
        return this.send({kind:'avatar',image});
    }
    send(message,destinationIdentities=undefined,reliable=true) {
        if(!this.#connected)return Promise.reject(new Error('RTC room is not connected'));
        const data=new TextEncoder().encode(JSON.stringify(message));
        return this.#room.localParticipant.publishData(data,{reliable,topic:rtcDataTopic,
            ...(destinationIdentities ? {destinationIdentities} : {})});
    }
    /** Select a local device; while not connected the choice applies at the next connect. */
    selectDevice(name,deviceId) {
        if(!this.#connected||!deviceId||this.#room.getActiveDevice(rtcDevices[name])===deviceId)return null;
        return this.#room.switchActiveDevice(rtcDevices[name],deviceId).then(()=>undefined,error=>{
            throw new Error(`Device selection failed: ${error.message}`);
        });
    }
    /** Participants with their visible tracks; empty when not connected. */
    participants() {
        if(!this.#connected)return [];
        const room=this.#room,{Track}=this.#livekit,local=room.localParticipant;
        return [local,...room.remoteParticipants.values()].map(participant=>({
            identity:participant.identity,name:participant.name??'',speaking:participant.isSpeaking,local:participant===local,
            microphone:participant.isMicrophoneEnabled,camera:participant.isCameraEnabled,screen:participant.isScreenShareEnabled,
            connectionQuality:participant.connectionQuality,role:participant.attributes[rtcRoleAttribute] || null,
            state:participant.attributes[rtcStateAttribute] || null,
            hand:participant===local ? this.#hand : this.#hands.has(participant.identity),
            avatar:participant===local ? this.#avatar : this.#avatars.get(participant.identity) ?? null,
            tracks:{camera:visible(participant.getTrackPublication(Track.Source.Camera)),
                screen:visible(participant.getTrackPublication(Track.Source.ScreenShare)),
                microphone:participant===local?null:visible(participant.getTrackPublication(Track.Source.Microphone))}
        }));
    }
    #changed() { if(this.#connected)this.#events.changed(); }
    async #listDevices(room) {
        const {Room}=this.#livekit;
        try {
            const lists=await Promise.all(Object.values(rtcDevices).map(kind=>Room.getLocalDevices(kind,false)));
            if(room!==this.#room)return;
            this.#events.devices(Object.fromEntries(Object.keys(rtcDevices).map((name,index)=>[name,
                lists[index].map(({deviceId,label})=>({deviceId,label}))])));
            for(const [name,kind] of Object.entries(rtcDevices)) {
                const deviceId=room.getActiveDevice(kind);
                if(deviceId)this.#events.activeDevice(name,deviceId);
            }
        }
        catch(error) { if(room===this.#room)this.#events.error(new Error(`Device listing failed: ${error.message}`)); }
    }
    /** A local track muted or unpublished outside setMedia (browser UI, server mute) writes its flag back. */
    #ended(publication) {
        const kind=rtcMediaKinds.find(name=>MEDIA[name].source===publication.source);
        if(kind && this.#media[kind]){this.#media[kind]=false;this.#events.mediaEnded(kind);}
    }
    /**
     * A participant that joins, or that receives the subscribe permission (lobby admission), did not see a hand
     * raised before nor the avatar: the local raised hand and avatar are sent again to that participant only.
     */
    #rebroadcast(participant) {
        if(!this.#room.localParticipant.permissions?.canPublishData)return;
        const room=this.#room;
        if(this.#hand)this.send({kind:'hand',raised:true},[participant.identity]).catch(error=>{
            if(this.#room===room)this.#events.error(new Error(`Raise hand failed: ${error.message}`));
        });
        if(this.#avatar)this.send({kind:'avatar',image:this.#avatar},[participant.identity]).catch(error=>{
            if(this.#room===room)this.#events.error(new Error(`Avatar failed: ${error.message}`));
        });
    }
    #received(payload,participant,topic) {
        if(topic!==rtcDataTopic)return;
        let message;
        try { message=JSON.parse(new TextDecoder().decode(payload)); }
        catch { return; }
        // Unknown kinds and malformed payloads come from other clients: the room ignores them.
        if(message?.kind==='hand' && participant && typeof message.raised==='boolean') {
            if(message.raised)this.#hands.add(participant.identity);
            else this.#hands.delete(participant.identity);
            this.#changed();
        }
        else if(message?.kind==='avatar' && participant && (message.image===null || rtcAvatarAllowed(message.image))) {
            if(message.image)this.#avatars.set(participant.identity,message.image);
            else this.#avatars.delete(participant.identity);
            this.#changed();
        }
        else if(message?.kind==='reaction' && participant && typeof message.value==='string')
            this.#events.received({kind:'reaction',value:message.value},participant.identity);
        else if(message?.kind==='chat' && participant && typeof message.text==='string' && message.text)
            this.#events.received({kind:'chat',text:message.text,private:message.private===true},participant.identity);
        // Only the server, which sends without a participant, may ask for an unmute.
        else if(message?.kind==='unmute-request' && !participant)this.#events.received({kind:'unmute-request'},null);
        else if(participant && rtcAnnotationAllowed(message,participant.identity,participant.attributes[rtcRoleAttribute]==='admin'))
            this.#events.received({...message,...(message.kind==='stroke'?{author:participant.identity}:{})},participant.identity);
    }
    #listen(room,livekit) {
        const {RoomEvent,DisconnectReason}=livekit;
        room.on(RoomEvent.ParticipantConnected,participant=>{
            if(!this.#connected)return;
            this.#rebroadcast(participant);
            this.#changed();
        });
        room.on(RoomEvent.ParticipantDisconnected,participant=>{
            this.#hands.delete(participant.identity);
            this.#avatars.delete(participant.identity);
            this.#changed();
        });
        for(const event of [RoomEvent.TrackPublished,
            RoomEvent.TrackUnpublished,RoomEvent.TrackSubscribed,RoomEvent.TrackUnsubscribed,
            RoomEvent.TrackUnmuted,RoomEvent.ActiveSpeakersChanged,RoomEvent.ParticipantNameChanged,
            RoomEvent.ConnectionQualityChanged,RoomEvent.ParticipantAttributesChanged])
            room.on(event,()=>this.#changed());
        room.on(RoomEvent.LocalTrackPublished,()=>{
            this.#changed();
            // Device labels become readable once a permission was granted.
            void this.#listDevices(room);
        });
        room.on(RoomEvent.LocalTrackUnpublished,publication=>{
            // A screen share stopped from the browser UI unpublishes its track.
            this.#ended(publication);
            this.#changed();
        });
        room.on(RoomEvent.TrackMuted,(publication,participant)=>{
            // A server mute (MutePublishedTrack) mutes the local track: the flag follows.
            if(participant===room.localParticipant)this.#ended(publication);
            this.#changed();
        });
        room.on(RoomEvent.ParticipantPermissionsChanged,(previous,participant)=>{
            if(!this.#connected)return;
            if(participant!==room.localParticipant) {
                if(participant.permissions?.canSubscribe && !previous?.canSubscribe)this.#rebroadcast(participant);
                return;
            }
            // A revoked permission removes the local tracks; a granted one (lobby admission) lets the room apply the requested flags.
            if(!this.canPublish)for(const kind of rtcMediaKinds)if(this.#media[kind]){this.#media[kind]=false;this.#events.mediaEnded(kind);}
            this.#events.canPublish(this.canPublish);
            this.#changed();
        });
        room.on(RoomEvent.DataReceived,(payload,participant,kind,topic)=>this.#received(payload,participant,topic));
        room.on(RoomEvent.MediaDevicesChanged,()=>void this.#listDevices(room));
        room.on(RoomEvent.ActiveDeviceChanged,(kind,deviceId)=>{
            const name=Object.keys(rtcDevices).find(key=>rtcDevices[key]===kind);
            if(name)this.#events.activeDevice(name,deviceId);
        });
        room.on(RoomEvent.Reconnecting,()=>this.#events.state('reconnecting'));
        room.on(RoomEvent.Reconnected,()=>this.#events.state('connected'));
        room.on(RoomEvent.Disconnected,reason=>{
            const error=new Error(`Disconnected from the RTC room: ${DisconnectReason[reason] ?? reason}`);
            void this.disconnect().then(()=>this.#events.error(error),cleanupError=>this.#events.error(cleanupError));
        });
    }
}
