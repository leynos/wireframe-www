/**
 * @file Playback for wireframe's Three.js plates.
 *
 * Every plate is server-rendered as a complete poster with an HTML caption,
 * so the page is whole without this script, without WebGL, and in print. The
 * script adds the live scene, following section 10 of the Common Signal
 * identity (v0.4), with the owner's choice of no Pause or glow controls:
 *
 * - Under ordinary motion settings a plate plays without being asked and
 *   without controls: the hero as the page loads, the others as they scroll
 *   into view. Off screen or in a hidden tab, the element stops drawing.
 * - When the browser asks for reduced motion, every plate is a poster with a
 *   "Play illustration" button, and no renderer or WebGL context exists until
 *   that button is pressed. Pressing it plays that one plate, through the
 *   vendored element's `allow-motion` attribute, and offers "Show still",
 *   which returns it to the poster.
 * - If the preference changes to reduce, every live plate stops at once and
 *   every opt-in is forgotten. If it changes back, plates in view play.
 * - If the runtime cannot load or a plate loses WebGL, the poster stays and
 *   says so; no control is offered that could not work.
 * - Under `prefers-contrast: more` or forced colours, live plates draw with
 *   the element's `low-glow` attribute.
 *
 * The scene itself is `<wireframe-plate>`, loaded on demand as an ES module
 * by dynamic `import()`; this file stays a classic script. The element owns
 * its canvas inside a shadow root and is hidden from assistive technology:
 * the poster's `alt` and the caption are the plate's one accessible
 * description, and the buttons stay in the light DOM beside them.
 *
 * At most `MAX_LIVE` plates keep a renderer. Mounting one more evicts the
 * least recently seen plate that is out of view, which remounts when it
 * returns; a plate in view is never evicted, so the cap cannot turn a
 * visible plate into a poster.
 *
 * A figure may also ask to be driven by the reader's scroll, through
 * `data-wf-drive`: `approach` dollies the camera in as the plate rises
 * through the viewport, `hold` slows the scene's traffic to a near stop while
 * the plate is centred (back-pressure, drawn), and `strain` bends the glass
 * at the same moment. These use the vendored element's `approach`, `tempo`,
 * and `warp` attributes, and run only under ordinary motion: scroll-linked
 * movement is still movement, so a reduced-motion opt-in plays the scene
 * as drawn and nothing more.
 *
 * `presentation` and `driven` are pure queries, exported with the controller
 * for the Bun tests; `init` supplies the browser's dependencies.
 */ (()=>{
    "use strict";
    /* A page rarely shows more than two plates at once; the cap bounds the
     contexts kept by plates that have scrolled away. */ const MAX_LIVE = 4;
    /* The words for each state the element reports, so the status says what
     the scene is actually doing rather than what was asked of it. */ const ELEMENT_STATUS = {
        scanning: "Playing",
        stable: "Playing",
        paused: "Paused",
        still: "Still"
    };
    const UNAVAILABLE = "Live illustration unavailable; showing the still.";
    /* What the controller remembers about one plate between events. */ /** Under reduced motion, the visitor pressed Play for this plate. */ /** The plate is in or near the viewport. */ /** The runtime or WebGL is unavailable for this plate. */ /* What a plate should look like for a state: whether a live scene may be
     mounted, how it is set, and which controls show. */ /* Media queries the controller reads and listens to. */ /* The observer the controller uses to learn when a plate is in view. */ /* What `createPlateController` needs from its host. */ /** Resolves once `<wireframe-plate>` is defined; rejects if it cannot be. */ /** Whether the browser can create the WebGL 2 context the runtime needs. */ /* One wired figure and its live element, if mounted. */ /* Decide how a plate presents. A failed plate is a poster with a note;
     under reduced motion only an explicit opt-in mounts a scene, and the
     controls offer Play or Show still; under ordinary motion a plate is
     live and has no controls. */ function presentation(mode, state) {
        if (state.failed) {
            return {
                live: false,
                allowMotion: false,
                showControls: true,
                showPlay: false,
                showStill: false,
                status: UNAVAILABLE
            };
        }
        if (mode === "normal") {
            return {
                live: true,
                allowMotion: false,
                showControls: false,
                showPlay: false,
                showStill: false,
                status: "Playing"
            };
        }
        return {
            live: state.optIn,
            allowMotion: state.optIn,
            showControls: true,
            showPlay: !state.optIn,
            showStill: state.optIn,
            status: state.optIn ? "Playing" : "Still"
        };
    }
    /* The attributes a drive spec asks for at a scroll progress, where 0 is
     the plate's top edge entering the viewport from below and 1 is its
     bottom edge leaving at the top. */ const DRIVEN_ATTRIBUTES = [
        "approach",
        "tempo",
        "warp"
    ];
    function driven(spec, progress) {
        const p = Math.min(1, Math.max(0, progress));
        const ease = (x)=>{
            const t = Math.min(1, Math.max(0, x));
            return t * t * (3 - 2 * t);
        };
        // Full at the centre of the viewport, gone a quarter of the way either side.
        const centred = ease(1 - Math.abs(p - 0.5) / 0.25);
        const out = {};
        for (const word of spec.split(/\s+/)){
            if (word === "approach") out.approach = ease((p - 0.15) / 0.6).toFixed(3);
            if (word === "hold") out.tempo = (1 - 0.94 * centred).toFixed(3);
            if (word === "strain") out.warp = (0.7 * centred).toFixed(3);
        }
        return out;
    }
    /* Wire every `[data-wf-plate]` figure in the document. Returns the plates
     and a `sync` hook for tests. */ function createPlateController(deps) {
        const doc = deps.document;
        const figures = Array.from(doc.querySelectorAll("[data-wf-plate]"));
        const plates = [];
        let clock = 0;
        let runtime = null;
        const mode = ()=>deps.reducedMotion.matches ? "reduced" : "normal";
        /* Load the runtime once. If it cannot load, no plate on the page can
       play, so every plate says so at once rather than when it is reached. */ function load(url) {
            if (!runtime) {
                runtime = deps.loadRuntime(url);
                runtime.catch(()=>{
                    for (const plate of plates)plate.state.failed = true;
                    renderAll();
                });
            }
            return runtime;
        }
        function unmount(plate) {
            if (!plate.element) return;
            plate.element.remove();
            plate.element = null;
            plate.figure.dataset.wfPlateLive = "false";
        }
        /* Make room for one more renderer by releasing the least recently seen
       plate that is out of view. */ function evict(except) {
            const mounted = plates.filter((p)=>p.element);
            if (mounted.length < MAX_LIVE) return;
            const idle = mounted.filter((p)=>p !== except && !p.state.visible).sort((a, b)=>a.seen - b.seen)[0];
            if (idle) unmount(idle);
        }
        function mount(plate) {
            if (plate.element) return;
            evict(plate);
            const element = doc.createElement("wireframe-plate");
            element.setAttribute("plate", plate.figure.dataset.wfPlate ?? "");
            element.setAttribute("aria-hidden", "true");
            element.className = "wf-plate__live";
            const still = plate.poster.cloneNode(false);
            still.alt = "";
            still.removeAttribute("class");
            still.removeAttribute("id");
            element.append(still);
            // `plate-state` does not bubble, so it is heard on the element itself.
            element.addEventListener("plate-state", (event)=>{
                const detail = event.detail;
                if (detail === "fallback") plate.state.failed = true;
                render(plate);
            });
            plate.element = element;
            plate.stage.append(element);
            plate.figure.dataset.wfPlateLive = "true";
        }
        /* Apply a plate's presentation: mount or unmount the scene, set its
       attributes, and show the controls that apply. */ function render(plate) {
            const shown = presentation(mode(), plate.state);
            const wantMount = shown.live && (plate.element !== null || plate.state.visible);
            if (!wantMount) unmount(plate);
            plate.controls.hidden = !shown.showControls;
            plate.play.hidden = !shown.showPlay;
            plate.still.hidden = !shown.showStill;
            const reported = plate.element ? ELEMENT_STATUS[plate.element.dataset.state ?? ""] : undefined;
            let words = reported ?? shown.status;
            if (!reported && wantMount) words = "Loading";
            // A plate waiting to scroll into view is neither playing nor still yet.
            if (!wantMount && shown.live) words = "";
            plate.status.textContent = words;
            plate.figure.dataset.wfPlateState = plate.state.failed ? "fallback" : (words || "waiting").toLowerCase();
            if (!wantMount) return;
            const url = plate.figure.dataset.wfPlateRuntime ?? "";
            load(url).then(()=>{
                const now = presentation(mode(), plate.state);
                if (!now.live) return;
                if (!plate.element && !plate.state.visible) return;
                mount(plate);
                const element = plate.element;
                if (!element) return;
                element.toggleAttribute("allow-motion", now.allowMotion);
                element.toggleAttribute("low-glow", deps.moreContrast.matches);
            }, ()=>{
                plate.state.failed = true;
                render(plate);
            });
        }
        function renderAll() {
            for (const plate of plates)render(plate);
        }
        /* Tie each mounted, driven plate to the scroll position. Under reduced
       motion every driven attribute is cleared instead. */ function drive(viewHeight) {
            for (const plate of plates){
                const spec = plate.figure.dataset.wfDrive;
                const element = plate.element;
                if (!spec || !element) continue;
                if (mode() === "reduced") {
                    for (const name of DRIVEN_ATTRIBUTES)element.removeAttribute(name);
                    continue;
                }
                const box = plate.figure.getBoundingClientRect();
                const progress = (viewHeight - box.top) / (viewHeight + box.height || 1);
                for (const [name, value] of Object.entries(driven(spec, progress))){
                    element.setAttribute(name, value);
                }
            }
        }
        /* Play under reduced motion: opt this one plate in, and keep focus on a
       control that is still there. */ function onPlay(plate) {
            plate.state.optIn = true;
            plate.state.visible = true;
            render(plate);
            plate.still.focus();
        }
        function onStill(plate) {
            plate.state.optIn = false;
            unmount(plate);
            render(plate);
            plate.play.focus();
        }
        for (const figure of figures){
            const stage = figure.querySelector("[data-wf-plate-stage]");
            const poster = figure.querySelector("[data-wf-plate-poster]");
            const controls = figure.querySelector("[data-wf-plate-controls]");
            const play = figure.querySelector("[data-wf-plate-play]");
            const still = figure.querySelector("[data-wf-plate-still]");
            const status = figure.querySelector("[data-wf-plate-status]");
            if (!stage || !poster || !controls || !play || !still || !status) continue;
            const plate = {
                figure,
                stage,
                poster,
                controls,
                play,
                still,
                status,
                element: null,
                seen: 0,
                state: {
                    optIn: false,
                    visible: false,
                    failed: !deps.webgl
                }
            };
            plates.push(plate);
            play.addEventListener("click", ()=>onPlay(plate));
            still.addEventListener("click", ()=>onStill(plate));
        }
        const observer = deps.observe((entries)=>{
            for (const entry of entries){
                const plate = plates.find((p)=>p.figure === entry.target);
                if (!plate) continue;
                plate.state.visible = entry.isIntersecting;
                if (entry.isIntersecting) plate.seen = ++clock;
                render(plate);
            }
        });
        for (const plate of plates)observer.observe(plate.figure);
        /* A change to reduce stops everything and forgets every opt-in; a change
       back lets plates in view play again. */ deps.reducedMotion.addEventListener("change", ()=>{
            if (mode() === "reduced") {
                for (const plate of plates){
                    plate.state.optIn = false;
                    unmount(plate);
                }
            }
            renderAll();
        });
        /* The hero starts loading the runtime at once rather than at first
       intersection, so its scene is ready as soon as it can be drawn. */ const eager = plates.find((p)=>p.figure.hasAttribute("data-wf-plate-eager"));
        if (eager && mode() === "normal" && !eager.state.failed) {
            load(eager.figure.dataset.wfPlateRuntime ?? "").catch(()=>undefined);
        }
        renderAll();
        return {
            plates,
            sync: renderAll,
            drive
        };
    }
    /* Wire the page's plates with the browser's own dependencies. */ function init() {
        const controller = createPlateController({
            document,
            reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)"),
            moreContrast: window.matchMedia("(prefers-contrast: more), (forced-colors: active)"),
            observe: (callback)=>new IntersectionObserver(callback, {
                    rootMargin: "200px 0px"
                }),
            loadRuntime: (url)=>import(url).then(()=>customElements.whenDefined("wireframe-plate")).then(()=>undefined),
            webgl: typeof window.WebGL2RenderingContext === "function"
        });
        if (!document.querySelector("[data-wf-drive]")) return;
        let queued = false;
        const update = ()=>{
            queued = false;
            controller.drive(window.innerHeight);
        };
        const request = ()=>{
            if (queued) return;
            queued = true;
            window.requestAnimationFrame(update);
        };
        window.addEventListener("scroll", request, {
            passive: true
        });
        window.addEventListener("resize", request, {
            passive: true
        });
        // A plate mounts after the runtime loads; drive it from its first frame.
        document.addEventListener("plate-state", request, true);
        request();
    }
    if (typeof document !== "undefined" && typeof window !== "undefined" && typeof window.IntersectionObserver === "function") {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", init);
        } else {
            init();
        }
    }
    if (typeof module !== "undefined" && module.exports) {
        module.exports = {
            presentation,
            driven,
            createPlateController,
            MAX_LIVE
        };
    }
})();
