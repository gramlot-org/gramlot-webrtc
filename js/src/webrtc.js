import {defineCollection,defineComponent,Container} from '@gramlot/gramlot/components';
import {RtcRoomSession,rtcMediaKinds,rtcDevices,rtcAnnotationKinds,rtcAnnotationAllowed} from './rtc-room-session.js';
import {RtcAnnotations} from './rtc-annotations.js';
import drawing from '@gramlot/gramlot/components/drawing';

// A tile keeps its aspect ratio; given a definite height (height:100% in a sized box) it fills that box.
const TILE_STYLE=`.control-box{height:100%}
    .tile{position:relative;aspect-ratio:16/9;width:100%;height:100%;min-width:0;overflow:hidden;border-radius:var(--gramlot-radius-sm,6px);
        background:#1d1f24;color:#fff}
    .tile video{display:block;width:100%;height:100%;object-fit:contain}
    .tile:not([data-video]) video{display:none}
    .tile .name{position:absolute;left:.5rem;bottom:.5rem;max-width:calc(100% - 1rem);padding:.15rem .45rem;border-radius:4px;
        background:rgb(0 0 0 / .55);font-size:.85em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .tile .face{position:absolute;left:50%;top:42%;transform:translate(-50%,-50%);height:min(52%,96px);width:auto;aspect-ratio:1;
        border-radius:50%;display:none;place-items:center;object-fit:cover;font-size:1.4em;font-weight:600;color:#fff;user-select:none}
    .tile:not([data-video]) .face:not([hidden]){display:grid}
    .tile[data-speaking]::after{content:"";position:absolute;inset:0;z-index:1;pointer-events:none;
        box-sizing:border-box;border:3px solid var(--gramlot-focus-ring,#3b82f6);border-radius:inherit}`;

/** The initials of a display name: the first letter of its first two words. */
export function rtcInitials(name) {
    return String(name ?? '').trim().split(/\s+/).filter(Boolean).slice(0,2).map(word=>[...word][0].toUpperCase()).join('');
}
/** The background color of the initials of an identity: a hue derived from the identity. */
export function rtcInitialsColor(identity) {
    let hash=0;
    for(const char of String(identity ?? ''))hash=(hash*31+char.codePointAt(0))>>>0;
    return `hsl(${hash%360} 45% 42%)`;
}

/** One box showing one video track; while no track is visible, the avatar image or the initials above the name. */
class TrackView {
    #track=null;
    constructor(document) {
        this.element=document.createElement('div');this.element.className='tile';
        this.video=document.createElement('video');this.video.muted=true;this.video.autoplay=true;this.video.playsInline=true;
        this.image=document.createElement('img');this.image.className='face';this.image.alt='';
        this.initials=document.createElement('span');this.initials.className='face';this.initials.setAttribute('aria-hidden','true');
        this.name=document.createElement('span');this.name.className='name';
        this.element.append(this.video,this.image,this.initials,this.name);
    }
    show(source,participant) {
        const track=participant?.tracks[source] ?? null;
        this.element.dataset.source=source;
        this.element.toggleAttribute('data-speaking',Boolean(participant?.speaking));
        const name=participant ? participant.name || participant.identity : '';
        this.name.textContent=participant ? name+(source==='screen'?' (screen)':'') : '';
        // The face shows the camera owner without video: the avatar image when given, otherwise the initials.
        const avatar=source==='camera' ? participant?.avatar ?? null : null;
        this.image.hidden=!avatar;
        if(avatar&&this.image.getAttribute('src')!==avatar)this.image.src=avatar;
        if(!avatar)this.image.removeAttribute('src');
        this.initials.hidden=Boolean(avatar)||!participant||source!=='camera';
        this.initials.textContent=rtcInitials(name);
        this.initials.style.background=rtcInitialsColor(participant?.identity);
        if(track===this.#track)return;
        this.#track?.detach(this.video);
        this.#track=track;
        if(track)track.attach(this.video);
        this.element.toggleAttribute('data-video',track!==null);
    }
    dispose() { this.show(this.element.dataset.source,null);this.element.remove(); }
}

export const RtcRoom=defineComponent({
    name:'rtcRoom',tag:'gramlot-rtc-room',base:Container,sourceContext:true,subTags:'*',
    parameters:{url:{dtype:'T',default:'',binding:'read'},token:{dtype:'T',default:'',binding:'read'},
        connect:{dtype:'B',default:false,binding:'twoWay'},microphone:{dtype:'B',default:false,binding:'twoWay'},
        camera:{dtype:'B',default:false,binding:'twoWay'},screen:{dtype:'B',default:false,binding:'twoWay'},
        status:{dtype:'T',default:'disconnected',binding:'twoWay'},error:{dtype:'T',default:'',binding:'twoWay'},
        participants:{dtype:'X',nullable:true,binding:'twoWay'},grid:{dtype:'B',default:true,binding:'read'},
        hand:{dtype:'B',default:false,binding:'twoWay'},reaction:{dtype:'T',nullable:true,binding:'read'},
        lastReaction:{dtype:'X',nullable:true,binding:'twoWay'},chat:{dtype:'X',nullable:true,binding:'read'},
        lastChat:{dtype:'X',nullable:true,binding:'twoWay'},unmuteRequested:{dtype:'B',default:false,binding:'twoWay'},
        canPublish:{dtype:'B',nullable:true,binding:'twoWay'},avatar:{dtype:'T',default:'',binding:'read'},
        annotation:{dtype:'X',nullable:true,binding:'read'},lastAnnotation:{dtype:'X',nullable:true,binding:'twoWay'},
        audioInputs:{dtype:'X',nullable:true,binding:'twoWay'},videoInputs:{dtype:'X',nullable:true,binding:'twoWay'},
        audioOutputs:{dtype:'X',nullable:true,binding:'twoWay'},audioInput:{dtype:'T',default:'',binding:'twoWay'},
        videoInput:{dtype:'T',default:'',binding:'twoWay'},audioOutput:{dtype:'T',default:'',binding:'twoWay'}},
    implementation:Base=>class extends Base {
        #context; #session; #active=false; #requested=false; #hide; #grid; #sounds; #views=new Map(); #audio=new Map();
        #tabPublishing=false; #tiles=new Set(); #list=[]; #written; #gridShown=true; #ready=false;
        constructor() {
            super();
            const style=this.ownerDocument.createElement('style');
            style.textContent=`.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,16rem),1fr));gap:.5rem}
                .grid:empty{display:none}.sounds{display:none}${TILE_STYLE}`;
            this.#grid=this.ownerDocument.createElement('div');this.#grid.className='grid';
            this.#sounds=this.ownerDocument.createElement('div');this.#sounds.className='sounds';
            this.controlBox.prepend(this.#grid);
            this.shadowRoot.append(style,this.#sounds);
        }
        setSourceContext(context){this.#context=context;}
        connectedCallback(){
            this.#active=true;
            this.#session=new RtcRoomSession(this.ownerDocument.defaultView,{
                state:status=>{this.#write('status',status);if(status==='disconnected')this.#write('canPublish',null);},
                error:error=>this.#failed(error),changed:()=>this.#render(),mediaEnded:kind=>this.#write(kind,false),
                received:(message,identity)=>this.#received(message,identity),
                control:(message,identity)=>this.dispatchEvent(new this.ownerDocument.defaultView.CustomEvent(
                    'rtc-control',{detail:{message,identity}})),
                canPublish:flag=>{this.#write('canPublish',flag);this.#syncMedia();this.#syncRoom();},
                devices:lists=>{for(const name of Object.keys(rtcDevices))this.#write(`${name}s`,lists[name]);},
                activeDevice:(name,deviceId)=>{if(this.parameters[name]!==deviceId)this.#write(name,deviceId);}});
            this.#hide=()=>{this.#requested=false;this.#ready=false;this.#write('connect',false);this.#leave();
                void this.#session.disconnect().catch(error=>this.#failed(error));};
            this.ownerDocument.defaultView.addEventListener('pagehide',this.#hide);
            this.#sync();
        }
        projectAttributes(attrs,adapt){
            const rest=super.projectAttributes(attrs,adapt);
            if(this.#active){this.#sync();if(this.parameters.reaction)this.#react(this.parameters.reaction);
                if(this.parameters.chat)this.#chat(this.parameters.chat);
                if(this.parameters.annotation)this.#annotate(this.parameters.annotation);}
            return rest;
        }
        /** Application bridge for an extension-captured tab; no second LiveKit connection. */
        async publishTabStream(stream) {
            this.#tabPublishing=true;
            try { await this.#session.publishTabStream(stream);this.#write('screen',true); }
            finally { this.#tabPublishing=false; }
        }
        sendControl(message,identity){return this.#session.sendControl(message,identity);}
        /** Register an rtcTile placed inside this room; the room keeps its track current. */
        attachTile(tile){this.#tiles.add(tile);this.#showTile(tile);}
        detachTile(tile){this.#tiles.delete(tile);}
        refreshTile(tile){if(this.#tiles.has(tile))this.#showTile(tile);}
        #showTile(tile){const {identity,source}=tile.parameters;tile.showParticipant(source,this.#list.find(item=>item.identity===identity) ?? null);}
        #write(name,value){if(this.#active)this.#context.writeParameter(name,value);}
        /** Flags that last only as long as the connection: a new connection starts without them. */
        #leave(){this.#write('screen',false);this.#write('hand',false);}
        #received(message,identity){
            if(rtcAnnotationKinds.includes(message.kind))this.#annotated(message,identity);
            else if(message.kind==='reaction')this.#write('lastReaction',{identity,value:message.value,at:new Date().toISOString()});
            else if(message.kind==='chat')this.#write('lastChat',{identity,text:message.text,private:message.private,to:null,local:false,at:new Date().toISOString()});
            else this.#write('unmuteRequested',true);
        }
        /** A received or sent annotation message reaches Data as lastAnnotation {identity, name, message, at}. */
        #annotated(message,identity){
            const name=this.#list.find(item=>item.identity===identity)?.name||identity;
            this.#write('lastAnnotation',{identity,name,message,at:new Date().toISOString()});
        }
        // annotation is fired like reaction. A pointer travels lossy and is not echoed; the other kinds are echoed
        // to lastAnnotation once sent, so the sender's view follows the same path as the others.
        #annotate(value){
            const identity=this.#session.identity,local=this.#list.find(item=>item.local);
            const message={...value,...(value.kind==='stroke'?{author:identity}:{})};
            if(!identity||!rtcAnnotationAllowed(message,identity,local?.role==='admin')){this.#write('error','Annotation not allowed');return;}
            const pointer=message.kind==='pointer';
            this.#session.send(message,undefined,!pointer).then(()=>{if(!pointer)this.#annotated(message,identity);},
                error=>this.#write('error',`Annotation failed: ${error.message}`));
        }
        #failed(error){
            if(!this.#active)return;
            this.#requested=false;this.#ready=false;this.#write('connect',false);this.#leave();this.#write('error',error.message);
            void this.#session.disconnect().then(()=>this.#write('status','error'),cleanupError=>console.error('RTC room cleanup failed',cleanupError));
        }
        #sync(){
            // An unset bound flag projects null: only true requests the room or a medium.
            const {url,token}=this.parameters,connect=this.parameters.connect===true;
            if(connect!==this.#requested) {
                this.#requested=connect;this.#ready=false;
                if(connect){this.#write('error','');this.#session.connect(url,token).then(()=>this.#joined(),error=>this.#failed(error));}
                else {this.#leave();void this.#session.disconnect().catch(error=>this.#failed(error));}
            }
            this.#syncMedia();
            this.#syncRoom();
            if((this.parameters.grid!==false)!==this.#gridShown)this.#render();
        }
        // Devices chosen before connecting apply before the first local track.
        #joined(){
            if(!this.#session.connected)return;
            Promise.all(Object.keys(rtcDevices).map(name=>this.#selectDevice(name))).then(()=>{
                if(!this.#session.connected||!this.#requested)return;
                this.#ready=true;this.#syncMedia();this.#syncRoom();});
        }
        #selectDevice(name){
            return this.#session.selectDevice(name,this.parameters[name])?.catch(error=>this.#write('error',error.message));
        }
        /** Hand, avatar and device selection while connected. */
        #syncRoom(){
            if(!this.#active||!this.#ready)return;
            this.#session.setHand(this.parameters.hand===true)?.catch(error=>{this.#write('hand',false);this.#write('error',error.message);});
            this.#session.setAvatar(this.parameters.avatar||null)?.catch(error=>this.#write('error',`Avatar failed: ${error.message}`));
            for(const name of Object.keys(rtcDevices))void this.#selectDevice(name);
        }
        // reaction is fired (FIRE): only the projection that carries the value sends it; its Data path is null again after it.
        #react(value){
            const identity=this.#session.identity;
            this.#session.send({kind:'reaction',value}).then(()=>this.#write('lastReaction',{identity,value,at:new Date().toISOString()}),
                error=>this.#write('error',`Reaction failed: ${error.message}`));
        }
        /**
         * chat is fired (FIRE) like reaction: {text} goes to everyone, {text,to} only to the participant `to` (private).
         * A sent message is written to lastChat as a received one, with local true and its recipient in `to`.
         */
        #chat(value){
            const message=typeof value?.asDict==='function'?value.asDict():value;
            const {text,to=null}=message ?? {};
            if(typeof text!=='string'||!text.trim())throw new TypeError('rtcRoom chat requires a text');
            if(to!==null&&(typeof to!=='string'||!to))throw new TypeError('rtcRoom chat `to` must be an identity');
            const identity=this.#session.identity,isPrivate=to!==null;
            this.#session.send({kind:'chat',text,private:isPrivate},isPrivate?[to]:undefined).then(
                ()=>this.#write('lastChat',{identity,text,private:isPrivate,to,local:true,at:new Date().toISOString()}),
                error=>this.#write('error',`Chat failed: ${error.message}`));
        }
        // Called synchronously from projectAttributes: a click that writes `screen` reaches getDisplayMedia in its activation.
        // Without the publish permission (lobby) microphone and camera wait for it; a screen share needs a new gesture.
        #syncMedia(){
            if(this.#tabPublishing)return;
            if(!this.#active||!this.#ready)return;
            if(!this.#session.canPublish){if(this.parameters.screen===true)this.#write('screen',false);return;}
            for(const kind of rtcMediaKinds)this.#session.setMedia(kind,this.parameters[kind]===true)?.catch(error=>{
                this.#write(kind,false);this.#write('error',error.message);});
        }
        #render(){
            if(!this.#active)return;
            const list=this.#session.participants(),document=this.ownerDocument;
            this.#list=list;this.#gridShown=this.parameters.grid!==false;
            this.#grid.hidden=!this.#gridShown;
            const wanted=[];
            if(this.#gridShown)for(const participant of list) {
                wanted.push([`${participant.identity}\u0000camera`,'camera',participant]);
                if(participant.tracks.screen)wanted.push([`${participant.identity}\u0000screen`,'screen',participant]);
            }
            const keys=new Set(wanted.map(([key])=>key));
            for(const [key,view] of this.#views)if(!keys.has(key)){view.dispose();this.#views.delete(key);}
            wanted.forEach(([key,source,participant],index)=>{
                let view=this.#views.get(key);
                if(!view){view=new TrackView(document);this.#views.set(key,view);}
                view.show(source,participant);
                if(this.#grid.children[index]!==view.element)this.#grid.insertBefore(view.element,this.#grid.children[index] ?? null);
            });
            const sounds=new Set(list.map(participant=>participant.tracks.microphone).filter(Boolean));
            for(const [track,element] of this.#audio)if(!sounds.has(track)){track.detach(element);element.remove();this.#audio.delete(track);}
            for(const track of sounds)if(!this.#audio.has(track)){const element=track.attach();this.#sounds.append(element);this.#audio.set(track,element);}
            for(const tile of this.#tiles)this.#showTile(tile);
            // The avatar images stay out of Data: `participants` is rewritten at every speaking change.
            const participants=list.length?list.map(({tracks,avatar,...participant})=>participant):null;
            const written=JSON.stringify(participants);
            if(written!==this.#written){this.#written=written;this.#write('participants',participants);}
        }
        disconnectedCallback(){
            this.ownerDocument.defaultView.removeEventListener('pagehide',this.#hide);
            this.#active=false;this.#requested=false;this.#ready=false;
            for(const view of this.#views.values())view.dispose();
            for(const [track,element] of this.#audio){track.detach(element);element.remove();}
            this.#views.clear();this.#audio.clear();this.#list=[];this.#written=undefined;
            for(const tile of this.#tiles)tile.showParticipant(tile.parameters.source,null);
            void this.#session.disconnect().catch(error=>console.error('RTC room cleanup failed',error));
        }
    }
});

export const RtcTile=defineComponent({
    name:'rtcTile',tag:'gramlot-rtc-tile',base:Container,
    // aspectRatio is also offered to a parent that declares the child parameter of the same name (trayPane).
    parameters:{identity:{dtype:'T',default:'',binding:'read'},source:{dtype:'T',default:'camera',binding:'read',enum:['camera','screen']},
        aspectRatio:{dtype:'R',default:16/9,binding:'read',childParameter:true}},
    implementation:Base=>class extends Base {
        #room=null; #view;
        constructor() {
            super();
            const style=this.ownerDocument.createElement('style');style.textContent=TILE_STYLE;
            this.#view=new TrackView(this.ownerDocument);
            this.controlBox.prepend(this.#view.element);this.shadowRoot.append(style);
        }
        connectedCallback(){
            this.#room=this.parentElement?.closest('gramlot-rtc-room') ?? null;
            if(!this.#room)throw new Error('rtcTile requires an enclosing rtcRoom');
            this.#room.attachTile(this);
        }
        projectAttributes(attrs,adapt){
            const rest=super.projectAttributes(attrs,adapt),{aspectRatio}=this.parameters;
            if(!(typeof aspectRatio==='number'&&Number.isFinite(aspectRatio)&&aspectRatio>0))throw new TypeError('rtcTile aspectRatio must be a positive number');
            this.#view.element.style.aspectRatio=String(aspectRatio);
            this.#room?.refreshTile(this);return rest;
        }
        showParticipant(source,participant){this.#view.show(source,participant);}
        disconnectedCallback(){this.#room?.detachTile(this);this.#room=null;this.#view.show(this.parameters.source,null);}
    }
});

// Avatar check used by the page logic of an application, outside the components.
export {rtcAvatarAllowed, rtcAvatarMaxLength} from './rtc-room-session.js';

export default defineCollection({name:'webrtc',dependencies:[drawing],assets:{livekitLicense:new URL('./licenses/livekit-client.txt',import.meta.url)},components:[RtcRoom,RtcTile,RtcAnnotations]});
