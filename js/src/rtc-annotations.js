import {Bag, randomId} from '@gramlot/gramlot';
import {defineComponent, Container} from '@gramlot/gramlot/components';

/** Height of the drawingPane surface in drawing units; its width is HEIGHT times the video ratio. */
const HEIGHT = 1000;
const POINTER_INTERVAL = 50;
const POINTER_FADE = 2000;
const HIT_TOLERANCE = 10;
const STROKE_WIDTH = 6;
const TEXT_WIDTH = 24;

const STYLE = `:host{display:block;height:100%;min-height:0}
    .control-box{position:relative;height:100%;min-height:0;overflow:hidden}
    ::slotted(gramlot-rtc-tile){height:100%}
    ::slotted(gramlot-drawing-pane){position:absolute;--gramlot-drawing-background:transparent}
    .surface,.pointers{position:absolute;touch-action:none}
    .pointers{pointer-events:none}
    .pointer{position:absolute;display:flex;align-items:center;gap:3px;transform:translate(-5px,-5px);transition:opacity .4s;
        font:600 10px/1.2 system-ui,sans-serif;color:#fff;white-space:nowrap}
    .pointer[data-faded]{opacity:0}
    .pointer i{width:10px;height:10px;border-radius:50%;background:#e5243b;box-shadow:0 0 0 2px #fff8}
    .pointer span{padding:0 4px;border-radius:3px;background:#000a}`;

/** A drawingPane row Bag as a shape of the shared image (0..1); `width` is the surface width in drawing units. */
export function rtcShapeFromRow(row, width) {
    const value = name => row.getItem(name);
    const base = {type: value('type'), color: value('color'), width: value('width')};
    const x = name => value(name) / width, y = name => value(name) / HEIGHT;
    if (base.type === 'arrow') return {...base, x: x('x'), y: y('y'), x2: x('x2'), y2: y('y2')};
    if (base.type === 'circle') return {...base, x: x('x'), y: y('y'), radius: value('radius') / HEIGHT};
    if (base.type === 'text') return {...base, x: x('x'), y: y('y'), text: value('text')};
    if (base.type === 'freehand') return {...base, points: value('points').getNodes().map(node =>
        [node.getValue().getItem('x') / width, node.getValue().getItem('y') / HEIGHT])};
    throw new TypeError(`Unknown annotation shape ${base.type}`);
}

/** A shape of the shared image (0..1) as a drawingPane row Bag on a surface `width` drawing units wide. */
export function rtcRowFromShape(shape, width, author = null) {
    const {type, color} = shape, base = {type, color, width: shape.width, ...(author ? {author} : {})};
    if (type === 'arrow') return new Bag({...base, x: shape.x * width, y: shape.y * HEIGHT, x2: shape.x2 * width, y2: shape.y2 * HEIGHT});
    if (type === 'circle') return new Bag({...base, x: shape.x * width, y: shape.y * HEIGHT, radius: shape.radius * HEIGHT});
    if (type === 'text') return new Bag({...base, x: shape.x * width, y: shape.y * HEIGHT, text: shape.text});
    if (type === 'freehand') return new Bag({...base, points: shape.points.map(([x, y]) => ({x: x * width, y: y * HEIGHT}))});
    throw new TypeError(`Unknown annotation shape ${type}`);
}

function segmentDistance(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Distance in drawing units from point p to the shape of a drawingPane row; 0 inside a text box. */
function rowDistance(row, p) {
    const value = name => row.getItem(name), type = value('type');
    if (type === 'arrow') return segmentDistance(p, {x: value('x'), y: value('y')}, {x: value('x2'), y: value('y2')});
    if (type === 'circle') return Math.abs(Math.hypot(p.x - value('x'), p.y - value('y')) - value('radius'));
    if (type === 'freehand') {
        const points = value('points').getNodes().map(node => ({x: node.getValue().getItem('x'), y: node.getValue().getItem('y')}));
        if (points.length === 1) return Math.hypot(p.x - points[0].x, p.y - points[0].y);
        return Math.min(...points.slice(1).map((point, index) => segmentDistance(p, points[index], point)));
    }
    const size = Math.max(14, 12 + value('width') * 2), x = value('x'), y = value('y');
    const right = x + 0.6 * size * String(value('text')).length;
    return Math.hypot(Math.max(x - p.x, 0, p.x - right), Math.max(y - size - p.y, 0, p.y - y));
}

/**
 * Annotations over a screen share: place it around the share's rtcTile and a drawingPane (toolbar=false). It lays the
 * drawingPane over the shared image inside the `object-fit: contain` bands, writes the image ratio to `ratio`, turns
 * drawn shapes into `stroke` messages and applies the received annotation messages of its share. Messages go out
 * through `outgoing` (bound to the rtcRoom `annotation`) and come in through `received` (the rtcRoom `lastAnnotation`).
 */
export const RtcAnnotations = defineComponent({
    name: 'rtcAnnotations', tag: 'gramlot-rtc-annotations', base: Container, sourceContext: true, subTags: '*',
    parameters: {share: {dtype: 'T', default: '', binding: 'read'}, sharer: {dtype: 'B', default: false, binding: 'read'},
        host: {dtype: 'B', default: false, binding: 'read'},
        tool: {dtype: 'T', default: 'pointer', binding: 'read', enum: ['pointer', 'freehand', 'arrow', 'circle', 'text']},
        locked: {dtype: 'B', default: false, binding: 'twoWay'}, shapes: {dtype: 'X', binding: 'read'},
        received: {dtype: 'X', nullable: true, binding: 'read'}, outgoing: {dtype: 'X', nullable: true, binding: 'twoWay'},
        ratio: {dtype: 'R', nullable: true, binding: 'twoWay'}},
    implementation: Base => class extends Base {
        #context; #active = false; #surface; #pointers; #rect = null; #width = HEIGHT * 16 / 9; #seen; #video = null;
        #resize; #events; #bag = null; #subscription = `rtc-annotations-${randomId()}`; #lastPointer = -Infinity; #trailing = null; #pending = null;
        #marks = new Map();
        constructor() {
            super();
            const d = this.ownerDocument, style = d.createElement('style');
            style.textContent = STYLE;
            this.#surface = d.createElement('div'); this.#surface.className = 'surface';
            this.#pointers = d.createElement('div'); this.#pointers.className = 'pointers';
            this.controlBox.append(this.#surface, this.#pointers);
            this.shadowRoot.append(style);
        }
        setSourceContext(context) { this.#context = context; }
        connectedCallback() {
            this.#active = true;
            this.#seen = this.parameters.received;
            const win = this.ownerDocument.defaultView;
            this.#events = new win.AbortController();
            const options = {signal: this.#events.signal};
            this.#resize = new win.ResizeObserver(() => this.#layout());
            this.#resize.observe(this);
            this.shadowRoot.querySelector('slot').addEventListener('slotchange', () => this.#layout(), options);
            this.#surface.addEventListener('pointermove', event => this.#pointerMoved(event), options);
            this.addEventListener('dblclick', event => this.#doubleClicked(event), options);
            this.#bind();
            this.#layout();
        }
        disconnectedCallback() {
            this.#active = false;
            this.#events?.abort(); this.#resize?.disconnect();
            this.#bag?.unsubscribe(this.#subscription, {any: true}); this.#bag = null;
            clearTimeout(this.#trailing);
            for (const {timer} of this.#marks.values()) clearTimeout(timer);
            this.#marks.clear(); this.#video = null;
        }
        projectAttributes(attrs, adapt) {
            const rest = super.projectAttributes(attrs, adapt);
            if (this.#active) {
                this.#bind();
                const received = this.parameters.received;
                if (received && received !== this.#seen) { this.#seen = received; this.#apply(received); }
                this.#mode();
            }
            return rest;
        }
        get #drawing() { return this.querySelector('gramlot-drawing-pane'); }
        get #enabled() { return this.parameters.locked !== true || this.parameters.host === true; }
        #bind() {
            const bag = this.parameters.shapes;
            if (!(bag instanceof Bag)) throw new TypeError('rtcAnnotations shapes requires a Data Bag');
            if (bag === this.#bag) return;
            this.#bag?.unsubscribe(this.#subscription, {any: true});
            this.#bag = bag;
            bag.subscribe(this.#subscription, {any: () => this.#drawn()});
        }
        /** Pointer mode leaves the events to the surface; a drawing tool gives them to the drawingPane. */
        #mode() {
            const drawing = this.#drawing, tool = this.parameters.tool, draw = tool !== 'pointer' && this.#enabled;
            this.#surface.style.pointerEvents = draw ? 'none' : 'auto';
            if (!drawing) return;
            drawing.style.pointerEvents = draw ? 'auto' : 'none';
            if (draw && typeof drawing.setTool === 'function') drawing.setTool(tool);
        }
        #write(name, value) { if (this.#active) this.#context.writeParameter(name, value); }
        /** Fire one message on the rtcRoom `annotation`: write it, then null, as FIRE does. */
        #send(message) { this.#write('outgoing', message); this.#write('outgoing', null); }
        /** Lay the drawingPane, the surface and the pointers over the shared image, inside the contain bands. */
        #layout() {
            if (!this.#active) return;
            const video = this.querySelector('gramlot-rtc-tile')?.shadowRoot?.querySelector('video') ?? null;
            if (video !== this.#video) {
                this.#video = video;
                if (video) {
                    for (const name of ['loadedmetadata', 'resize']) video.addEventListener(name, () => this.#layout(), {signal: this.#events.signal});
                    this.#resize.observe(video);
                }
            }
            this.#mode();
            if (!video) return;
            const box = video.getBoundingClientRect(), host = this.controlBox.getBoundingClientRect();
            const ratio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
            const scale = Math.min(box.width / ratio, box.height);
            const width = scale * ratio, height = scale;
            this.#rect = {left: box.left - host.left + (box.width - width) / 2, top: box.top - host.top + (box.height - height) / 2, width, height};
            for (const element of [this.#surface, this.#pointers, this.#drawing].filter(Boolean)) {
                Object.assign(element.style, {left: `${this.#rect.left}px`, top: `${this.#rect.top}px`,
                    width: `${width}px`, height: `${height}px`});
            }
            this.#setRatio(Math.round(ratio * 10000) / 10000);
        }
        /** A new image ratio rescales the stored shapes, so they keep their place on the image. */
        #setRatio(ratio) {
            const width = HEIGHT * ratio;
            if (this.parameters.ratio === ratio && width === this.#width) return;
            const previous = this.#width;
            this.#width = width;
            if (previous !== width) for (const node of this.#bag.getNodes()) {
                this.#bag.setItem(node.label, rtcRowFromShape(rtcShapeFromRow(node.getValue(), previous), width, node.getValue().getItem('author')));
            }
            this.#write('ratio', ratio);
        }
        #relative(event) {
            const box = this.#surface.getBoundingClientRect();
            if (!box.width || !box.height) return null;
            const clamp = value => Math.max(0, Math.min(1, value));
            return {x: clamp((event.clientX - box.left) / box.width), y: clamp((event.clientY - box.top) / box.height)};
        }
        /** At most one pointer message every POINTER_INTERVAL ms; the last position of a burst is sent at its end. */
        #pointerMoved(event) {
            if (!this.#enabled || this.parameters.tool !== 'pointer') return;
            const point = this.#relative(event);
            if (!point) return;
            const wait = this.#lastPointer + POINTER_INTERVAL - event.timeStamp;
            clearTimeout(this.#trailing);
            if (wait > 0) { this.#trailing = setTimeout(() => this.#pointerSent(point, event.timeStamp + wait), wait); return; }
            this.#pointerSent(point, event.timeStamp);
        }
        #pointerSent(point, time) {
            if (!this.#active) return;
            this.#lastPointer = time;
            this.#send({kind: 'pointer', share: this.parameters.share, ...point});
        }
        /** The sharer removes the shape nearest to a double click, within a few pixels. */
        #doubleClicked(event) {
            if (this.parameters.sharer !== true) return;
            const point = this.#relative(event), box = this.#surface.getBoundingClientRect();
            if (!point) return;
            const p = {x: point.x * this.#width, y: point.y * HEIGHT}, tolerance = HIT_TOLERANCE * HEIGHT / box.height;
            let nearest = null, distance = Infinity;
            for (const node of this.#bag.getNodes()) {
                const value = rowDistance(node.getValue(), p);
                if (value < distance) { distance = value; nearest = node.label; }
            }
            if (nearest === null || distance > tolerance) return;
            event.preventDefault();
            this.#send({kind: 'stroke-delete', share: this.parameters.share, id: nearest});
        }
        /** A shape the drawingPane inserted (label item_*) gets a stroke id and goes out as a `stroke` message. */
        #drawn() {
            if (this.#pending) return;
            this.#pending = Promise.resolve().then(() => {
                this.#pending = null;
                if (!this.#active) return;
                for (const node of this.#bag.getNodes().filter(node => node.label.startsWith('item_'))) {
                    const shape = rtcShapeFromRow(node.getValue(), this.#width), id = `s_${randomId()}`;
                    // A tile is small: strokes and text get a width readable at tile size (drawing units of a 1000 high image).
                    shape.width = shape.type === 'text' ? TEXT_WIDTH : Math.max(shape.width, STROKE_WIDTH);
                    this.#bag.popNode(node.label);
                    this.#bag.setItem(id, rtcRowFromShape(shape, this.#width));
                    this.#send({kind: 'stroke', share: this.parameters.share, id, shape});
                }
                // A committed text returns the drawingPane to select: the strip tool stays.
                this.#mode();
            });
        }
        #apply({identity, name, message}) {
            if (message.kind === 'draw-lock') { this.#write('locked', message.locked); return; }
            if (message.share !== this.parameters.share) return;
            if (message.kind === 'pointer') this.#mark(identity, name, message);
            else if (message.kind === 'stroke') this.#bag.setItem(message.id, rtcRowFromShape(message.shape, this.#width, message.author));
            else if (message.kind === 'stroke-delete') { if (this.#bag.getNode(message.id)) this.#bag.popNode(message.id); }
            else if (message.kind === 'strokes-clear') for (const node of [...this.#bag.getNodes()]) this.#bag.popNode(node.label);
        }
        /** Show the pointer of `identity` with its name; it fades after two seconds without movement. */
        #mark(identity, name, {x, y}) {
            let mark = this.#marks.get(identity);
            if (!mark) {
                const d = this.ownerDocument, element = d.createElement('div'), label = d.createElement('span');
                element.className = 'pointer'; element.dataset.identity = identity;
                element.append(d.createElement('i'), label);
                this.#pointers.append(element);
                mark = {element, label, timer: null};
                this.#marks.set(identity, mark);
            }
            mark.label.textContent = name || identity;
            mark.element.style.left = `${x * 100}%`; mark.element.style.top = `${y * 100}%`;
            mark.element.removeAttribute('data-faded');
            clearTimeout(mark.timer);
            mark.timer = setTimeout(() => mark.element.setAttribute('data-faded', ''), POINTER_FADE);
        }
    }
});
