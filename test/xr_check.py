# The immersive mode of the Observe page, run without a headset: headless Chromium with Meta's WebXR runtime
# emulator (iwer, a devDependency: it is injected here and is not part of the site) standing in for a Quest 3.
#   npx vite build --outDir /tmp/esl-xr --emptyOutDir; python3 -m http.server 8913 -d /tmp/esl-xr
#   .venv/bin/python test/xr_check.py [/tmp/esl-xr-shots]        (ESL_BASE overrides http://localhost:8913)
# It enters VR from the page's own button, points a controller where a star should be (from src/core/astro.js, not
# from the picking code), pulls the trigger and reads the card; drives the thumbstick, the grip, the buttons, the
# menu, a pinch and the gaze; enters passthrough; and saves pictures of the left eye. Lines print as
# `ok   name   numbers`. What this proves and what it cannot is in the README, "Immersive mode".
import os, sys, json
from playwright.sync_api import sync_playwright

BASE = os.environ.get('ESL_BASE', 'http://localhost:8913')
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/esl-xr-shots'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.makedirs(OUT, exist_ok=True)
fails = []
def check(name, cond, info=''):
    print(('ok   ' if cond else 'FAIL ') + name + ('   ' + str(info) if info != '' else ''), flush=True)
    if not cond: fails.append(name)

# Tucson, 2026-07-15 05:00 UTC (22:00 local): Vega high in the east, Arcturus in the west, the clock stopped
URL = BASE + '/observe/?skipintro&lat=32.2226&lon=-110.9747&t=2026-07-15T05:00:00Z&az=180&alt=20&layers=constellations,planets,atmosphere,ground,labels'

HELPERS = r"""
(() => {
  const k = window.__sky, X = k.X, A = k.A, RAD = Math.PI / 180, dev = window.__xrDevice;
  // an orientation that looks (or points) along a reference-space direction, without roll: yaw about y, then pitch
  const quatOf = (d) => { const yaw = -Math.atan2(d[0], -d[2]), pitch = Math.asin(Math.max(-1, Math.min(1, d[1]))), cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2); return [cy * sp, sy * cp, -sy * sp, cy * cp]; };
  const T = window.__t = {
    quatOf,
    /** Where a named star should be: airless alt-az from astro.js's fixedAltAz, refraction added as the page does. */
    star(name) { const s = k.data.stars, st = s.labelled.find((x) => x.proper === name), h = A.fixedAltAz(s.ra[st.i] * RAD, s.dec[st.i] * RAD, k.S.time, k.S.lat * RAD, k.S.lon * RAD); return { i: st.i, alt: h.alt + (k.S.layers.atmosphere ? A.refraction(h.alt) : 0), az: h.az }; },
    refDir(alt, az) { return X.worldToRef(X.dirOfAltAz(alt, az), k.xr.state.heading); },
    aim(hand, d, pos) { const c = dev.controllers[hand]; c.quaternion.set(...quatOf(d)); if (pos) c.position.set(...pos); },
    aimAt(hand, point) { const c = dev.controllers[hand], o = [c.position.x, c.position.y, c.position.z]; T.aim(hand, X.norm(point.map((v, i) => v - o[i]))); },
    look(d) { dev.quaternion.set(...quatOf(d)); },
    lookAt(point) { const o = [dev.position.x, dev.position.y, dev.position.z]; T.look(X.norm(point.map((v, i) => v - o[i]))); },
    /** The centre of a button of a panel, in the reference space. */
    button(panel, id) { const p = k.xr[panel], r = p.rects.find((x) => x.id === id); return r ? X.panelPoint(p.geom, (r.x + r.w / 2) / p.pw, (r.y + r.h / 2) / p.height) : null; },
    ray(i) { const p = k.xr.pointers[i]; return X.rayOfMatrix(p.controller.matrixWorld.elements); },
    pointer(hand) { return k.xr.pointers.find((p) => p.source && p.source.handedness === hand); },
    state() { const s = k.xr.state; return { frames: s.frames, selects: s.selects, haptics: s.haptics, heading: s.heading, grip: s.grip, aligning: s.aligning, menuOpen: s.menuOpen, lastHit: s.lastHit, refType: s.refType, features: s.features, frameRate: s.frameRate, kind: s.kind, rate: s.rate }; },
  };
})()
"""

with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    ctx = b.new_context(viewport={'width': 1600, 'height': 800})
    ctx.add_init_script(path=os.path.join(ROOT, 'node_modules/iwer/build/iwer.min.js'))
    ctx.add_init_script("window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3, { stereoEnabled: true }); window.__xrDevice.installRuntime({ forceInstall: true });")
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)))
    pg.on('console', lambda m: errs.append('console.' + m.type + ' ' + m.text) if m.type in ('error', 'warning') else None)
    pg.goto(URL)
    pg.wait_for_function("window.__sky && window.__sky.data.stars && window.__sky.data.stars.labelled && window.__sky.frame()", timeout=30000)
    pg.evaluate(HELPERS)
    ev = pg.evaluate
    def frames(n=6):
        f = ev("__sky.xr.state.frames"); pg.wait_for_function("f => __sky.xr.state.frames >= f", arg=f + n, timeout=20000)
    def shot(name, look=None, clip_left=True):
        if look is not None: ev("d => __t.look(d)", look); frames(4)
        vp = pg.viewport_size
        pg.screenshot(path=os.path.join(OUT, name + '.png'), clip={'x': 0, 'y': 0, 'width': vp['width'] // 2, 'height': vp['height']} if clip_left else None)
    def press(hand, button='trigger', hold=4):
        ev("([h, b]) => __xrDevice.controllers[h].updateButtonValue(b, 1)", [hand, button]); frames(hold)
        ev("([h, b]) => __xrDevice.controllers[h].updateButtonValue(b, 0)", [hand, button]); frames(3)
    def click_button(panel, bid, hand='right'):
        pt = ev("([p, id]) => __t.button(p, id)", [panel, bid])
        if pt is None: return False
        ev("([h, pt]) => __t.aimAt(h, pt)", [hand, pt]); frames(4); press(hand); return True

    # ---- before the session
    sup = ev("(async () => { const s = await __sky.xr.supported(); return { vr: s.vr, ar: s.ar, vrTitle: document.getElementById('vrBtn').title, pt: !document.getElementById('ptBtn').hidden }; })()")
    check('the emulated headset is detected: VR and passthrough offered', sup['vr'] and sup['ar'] and sup['pt'], json.dumps(sup)[:140])

    # ---- enter VR with the page's own button
    pg.click('#vrBtn')
    pg.wait_for_function("__sky.xr.presenting && __sky.xr.state.frames > 12", timeout=20000)
    st = ev("__t.state()")
    info = ev("({ mode: __sky.R.mode, presenting: __sky.R.renderer.xr.isPresenting, sources: __xrDevice.inputSources.map((s) => s.handedness + ':' + s.targetRayMode + ':' + s.profiles[0]), connected: __sky.xr.pointers.filter((p) => p.source).length, heading: __sky.xr.state.heading * 180 / Math.PI })")
    check('VR session started', info['presenting'] and info['mode'] == 'perspective' and st['kind'] == 'vr', f"reference space {st['refType']}, features {st['features']}, frame rate asked {st['frameRate']} Hz")
    check('two controllers connected', info['connected'] == 2, ', '.join(info['sources']))
    check('the viewer faces the azimuth of the flat view', abs(info['heading'] - 180) < 1e-9, f"heading {info['heading']:.1f} deg")
    shot('01-vr-start-menu', [0, -0.45, -0.9])

    # ---- point at Vega, pull the trigger
    vega = ev("__t.star('Vega')")
    d = ev("s => __t.refDir(s.alt, s.az)", vega)
    ev("d => __t.aim('right', d, [0.25, 1.35, -0.25])", d); frames(8)
    hov = ev("(() => { const p = __t.pointer('right'), r = __t.ray(p.i); return { name: p.nameText, ray: r.dir, line: p.line.visible, reticle: p.reticle.visible }; })()")
    sep = ev("([a, b]) => __sky.X.angle(a, b) * 180 / Math.PI", [hov['ray'], d])
    check('the controller ray is where it was aimed', sep < 1e-3, f"{sep:.2e} deg from the direction of Vega (alt {vega['alt']*57.29578:.2f}, az {vega['az']*57.29578:.2f} deg)")
    check('hover: the reticle names the star under the ray', hov['name'] == 'Vega' and hov['line'] and hov['reticle'], hov['name'])
    s0 = ev("__t.state()")
    press('right')
    r = ev("(() => { const k = __sky, c = k.xr.card; return { sel: k.S.selection, title: c.model && c.model.title, type: c.model && c.model.type, kv: c.model && c.model.kv, visible: c.mesh.visible, buttons: c.rects.filter((x) => x.id).map((x) => x.id), px: [c.canvas.width, c.canvas.height] }; })()")
    s1 = ev("__t.state()")
    check('trigger selects the star: the in-world card names it', r['title'] == 'Vega' and r['visible'] and r['sel'] and r['sel']['kind'] == 'star' and r['sel']['i'] == vega['i'], f"{r['type']} {r['title']}; {'; '.join(k + ' ' + v for k, v in r['kv'])}")
    check('one select event, one haptic pulse', s1['selects'] - s0['selects'] == 1 and s1['haptics'] > s0['haptics'], f"selects +{s1['selects'] - s0['selects']}, pulses +{s1['haptics'] - s0['haptics']}")
    check('the card has the page card\'s actions', 'mark' in r['buttons'] and 'close' in r['buttons'], ', '.join(r['buttons']))
    shot('02-vega-selected', d)
    shot('03-card-panel', ev("(() => { const g = __sky.xr.card.geom, o = [__xrDevice.position.x, __xrDevice.position.y, __xrDevice.position.z]; return __sky.X.norm(g.centre.map((v, i) => v - o[i])); })()"))

    # 1 degree off the star still takes it; empty sky clears the selection
    d1 = ev("s => __t.refDir(s.alt + Math.PI / 180, s.az)", vega)
    ev("d => __t.aim('right', d)", d1); frames(6); press('right')
    check('1 deg off the star still selects it', ev("__sky.xr.card.model && __sky.xr.card.model.title") == 'Vega')
    ev("d => __t.aim('right', d)", ev("__t.refDir(-0.5, 1.0)")); frames(6); press('right')
    check('a trigger on the ground clears the selection', ev("__sky.S.selection") is None and not ev("__sky.xr.card.mesh.visible"))

    # ---- thumbstick: time and the faintest stars
    ev("d => __t.aim('right', d)", d)
    t0 = ev("({ t: __sky.S.time, w: performance.now() })")
    ev("__xrDevice.controllers.right.updateAxes('thumbstick', 1, 0)"); frames(40)
    t1 = ev("({ t: __sky.S.time, w: performance.now(), rate: __sky.xr.state.rate })")
    ev("__xrDevice.controllers.right.updateAxes('thumbstick', 0, 0)"); frames(4)
    t2 = ev("__sky.S.time"); frames(10); t3 = ev("__sky.S.time")
    got = (t1['t'] - t0['t']) / (t1['w'] - t0['w'])
    check('thumbstick right runs time forwards at 2 h per second', t1['rate'] == 7200 and abs(got / 7200 - 1) < 0.2, f"{(t1['t'] - t0['t']) / 3600e3:.2f} h of sky in {(t1['w'] - t0['w']) / 1000:.2f} s: {got:.0f} s/s (the stick is released within that span)")
    check('released: the clock stands still again', t3 == t2)
    ev("__xrDevice.controllers.left.updateAxes('thumbstick', -0.5, 0)"); frames(30)
    rate = ev("__sky.xr.state.rate"); ev("__xrDevice.controllers.left.updateAxes('thumbstick', 0, 0)"); frames(4)
    t4 = ev("__sky.S.time")
    check('half deflection to the left (either hand): backwards, cubic', abs(rate + 7200 * (0.35 / 0.85) ** 3) < 1e-6 and t4 < t3, f"{rate:.1f} s/s")
    m0 = ev("({ off: __sky.S.magOffset, lim: __sky.frame().magLimit, w: performance.now() })")
    ev("__xrDevice.controllers.right.updateAxes('thumbstick', 0, -1)"); frames(30)
    ev("__xrDevice.controllers.right.updateAxes('thumbstick', 0, 0)"); frames(4)
    m1 = ev("({ off: __sky.S.magOffset, lim: __sky.frame().magLimit, w: performance.now() })")
    check('thumbstick up: fainter stars', m1['off'] > m0['off'] and m1['lim'] > m0['lim'], f"limit V {m0['lim']:.2f} -> {m1['lim']:.2f} in {(m1['w'] - m0['w']) / 1000:.2f} s (1.5 mag/s at the stop)")
    pl0 = ev("__sky.S.playing"); press('right', 'thumbstick'); pl1 = ev("__sky.S.playing"); press('right', 'thumbstick')
    check('thumbstick click pauses and resumes', pl0 != pl1 and ev("__sky.S.playing") == pl0)
    ev("(() => { __sky.setTime(Date.parse('2026-07-15T05:00:00Z')); __sky.S.playing = false; __sky.S.magOffset = 0; })()"); frames(4)

    # ---- grip: turn the sky, then (B) scrub time
    a0 = ev("__t.refDir(0.35, 2.0)"); ev("d => __t.aim('right', d)", a0); frames(4)
    h0 = ev("__sky.xr.state.heading"); w0 = ev("d => __sky.X.refToWorld(d, __sky.xr.state.heading)", a0)
    ev("__xrDevice.controllers.right.updateButtonValue('squeeze', 1)"); frames(4)
    # sweep 30 degrees to the right in the reference space, in steps (as a hand would)
    for kstep in range(1, 7):
        ev("([d, a]) => { const c = Math.cos(a), s = Math.sin(a); __t.aim('right', [c * d[0] - s * d[2], d[1], s * d[0] + c * d[2]]); }", [a0, kstep * 5 * 3.141592653589793 / 180]); frames(2)
    held = ev("(() => { const p = __t.pointer('right'), r = __t.ray(p.i); return { h: __sky.xr.state.heading, w: __sky.X.refToWorld(r.dir, __sky.xr.state.heading) }; })()")
    ev("__xrDevice.controllers.right.updateButtonValue('squeeze', 0)"); frames(4)
    turn = (held['h'] - h0) * 57.29578; drift = ev("([a, b]) => __sky.X.angle(a, b) * 180 / Math.PI", [w0, held['w']])
    check('grip + sweep turns the sky with the hand', abs(((turn + 180) % 360) - 180 + 30) < 1e-3 and drift < 1e-3, f"heading {turn:+.3f} deg for a 30 deg sweep; the sky point under the ray moved {drift:.1e} deg")
    press('right', 'b-button')
    check('B switches the grip to scrubbing time', ev("__sky.xr.state.grip") == 'time')
    ev("d => __t.aim('right', d)", a0); frames(4); tt0 = ev("__sky.S.time"); hh = ev("__sky.xr.state.heading")
    ev("__xrDevice.controllers.right.updateButtonValue('squeeze', 1)"); frames(4)
    for kstep in range(1, 4):
        ev("([d, a]) => { const c = Math.cos(a), s = Math.sin(a); __t.aim('right', [c * d[0] - s * d[2], d[1], s * d[0] + c * d[2]]); }", [a0, kstep * 5 * 3.141592653589793 / 180]); frames(2)
    ev("__xrDevice.controllers.right.updateButtonValue('squeeze', 0)"); frames(4)
    tt1 = ev("__sky.S.time")
    check('grip + sweep of 15 deg scrubs one hour, the sky stays', abs((tt1 - tt0) / 3600e3 - 1) < 1e-4 and ev("__sky.xr.state.heading") == hh, f"{(tt1 - tt0) / 60000:.3f} min")
    press('right', 'b-button')
    ev("(() => { __sky.setTime(Date.parse('2026-07-15T05:00:00Z')); __sky.xr.setHeading(Math.PI); })()"); frames(4)

    # ---- the menu, hit by the ray of the left controller
    ev("__xrDevice.controllers.left.position.set(-0.25, 1.3, -0.2)")
    rows = ev("__sky.xr.menu.rects.filter((r) => r.id).map((r) => r.id)")
    g0 = ev("__sky.S.layers.azgrid"); ok1 = click_button('menu', 'layer:azgrid', 'left'); g1 = ev("__sky.S.layers.azgrid")
    check('menu: trigger on "Alt-az grid" switches the layer', ok1 and g0 != g1, f"{len(rows)} buttons: {', '.join(rows[:8])} ...; last hit {ev('__t.state().lastHit')}")
    click_button('menu', 'layer:altlimit', 'left')
    check('menu: the 30 degree ring', ev("__sky.S.layers.altlimit") is True)
    pg.wait_for_function("__sky.tonight.status === 'ready' || __sky.tonight.status === 'error'", timeout=90000); frames(20)
    tn = ev("({ status: __sky.tonight.status, n: __sky.tonight.n, err: __sky.tonight.error, ev: __sky.tonight.events.map((e) => [e.planet, new Date(e.ingress).toISOString().slice(11, 16), new Date(e.egress).toISOString().slice(11, 16), Math.round(e.alt * 180 / Math.PI)]) })")
    check('tonight\'s observable transits are on the menu', tn['status'] == 'ready' and len(tn['ev']) > 0 and ev("!!__t.button('menu', 'tn:0')"), f"{tn['n']} found, shown: " + '; '.join(f"{e[0]} {e[1]}-{e[2]} UTC at {e[3]} deg" for e in tn['ev']) + ' ' + tn['err'])
    shot('04-menu-with-tonight', [0, -0.45, -0.9])
    if tn['ev']:
        click_button('menu', 'tn:0', 'left'); frames(10)
        tg = ev("({ target: __sky.S.target, transit: __sky.S.transit, marks: __sky.data.night ? __sky.data.night.marks.map((m) => m.name) : [], labels: __sky.xrLabels().filter((l) => /^mark|^target|^hour/.test(l.key)).length, card: __sky.xr.card.model && __sky.xr.card.model.title, notes: __sky.xr.card.model && __sky.xr.card.model.notes.map((n) => n.text || n) })")
        check('menu: a transit of tonight becomes the target, with its track and window', tg['target'] and tg['target']['planet'] == tn['ev'][0][0] and tg['transit'] and tg['marks'] == ['Ingress', 'Mid-transit', 'Egress'], f"{tg['target']['name']}; card: {tg['card']}; {tg['notes'][-1] if tg['notes'] else ''}")
        tdir = ev("(() => { const s = __sky.infoOf(__sky.S.target); return __t.refDir(s.alt, s.az); })()")
        shot('05-target-track', tdir)
        click_button('menu', 'next', 'left'); frames(6)
        nxt = ev("__sky.S.target && __sky.S.target.name")
        click_button('menu', 'prev', 'left'); frames(6)
        check('menu: next and previous target', nxt != tg['target']['name'] and ev("__sky.S.target.name") == tg['target']['name'], f"next: {nxt}")
        click_button('menu', 'night', 'left'); frames(20)
        np = ev("({ playing: __sky.S.playing, night: __sky.S.nightPlay, t: __sky.S.time, t0: __sky.data.night.t0 })")
        click_button('menu', 'night', 'left'); frames(4)
        check('menu: play the night, pause', np['playing'] and np['night'] and np['t'] > np['t0'] and not ev("__sky.S.playing"))
    n0 = ev("__sky.S.live"); click_button('menu', 'now', 'left'); frames(4)
    check('menu: now', ev("__sky.S.live") is True and abs(ev("__sky.S.time - Date.now()")) < 2000)
    ev("(() => { __sky.setTime(Date.parse('2026-07-15T05:00:00Z')); __sky.S.playing = false; __sky.clearTarget(); __sky.S.selection = null; })()"); frames(6)

    # ---- compass alignment: the sky is off by 25 degrees; point at where the object "really" is
    al = ev("__sky.alignTargets().map((t) => t.name)")
    click_button('menu', 'xr:align', 'left'); frames(4)
    a = ev("({ aligning: __sky.xr.state.aligning, target: __sky.alignTargets()[__sky.xr.state.alignIndex % __sky.alignTargets().length] })")
    real = ev("([t, off]) => { const d = __t.refDir(t.alt, t.az), c = Math.cos(off), s = Math.sin(off); return [c * d[0] - s * d[2], d[1], s * d[0] + c * d[2]]; }", [a['target'], 25 * 3.141592653589793 / 180])
    ev("d => __t.aim('right', d)", real); frames(6); press('right')
    after = ev("([t, real]) => { const d = __t.refDir(t.alt, t.az); return { sep: __sky.X.angle(d, real) * 180 / Math.PI, heading: __sky.xr.state.heading * 180 / Math.PI, aligning: __sky.xr.state.aligning, sel: __sky.S.selection }; }", [a['target'], real])
    check('"Point & set" turns the sky onto the object pointed at', a['aligning'] and not after['aligning'] and after['sep'] < 1e-3 and after['sel'] is None, f"on {a['target']['name']} (offered: {', '.join(al)}): heading 180 -> {after['heading'] % 360:.3f} deg, the drawn object is {after['sep']:.1e} deg from the ray")
    click_button('menu', 'xr:turnL', 'left'); frames(3)
    check('menu: turn the sky by 5 degrees', abs(((ev("__sky.xr.state.heading") * 57.29578 - after['heading'] + 180) % 360) - 180 + 5) < 1e-3)
    ev("__sky.xr.setHeading(Math.PI)")

    # ---- A folds the menu and brings it back in front of the head
    press('right', 'a-button'); frames(8)
    folded = ev("({ open: __sky.xr.state.menuOpen, ids: __sky.xr.menu.rects.filter((r) => r.id).map((r) => r.id) })")
    ev("__t.look([0.8, 0, -0.6])"); frames(4); press('right', 'a-button'); frames(8)
    back = ev("(() => { const g = __sky.xr.menu.geom, o = [__xrDevice.position.x, __xrDevice.position.y, __xrDevice.position.z], d = __sky.X.norm(g.centre.map((v, i) => v - o[i])); return { open: __sky.xr.state.menuOpen, az: Math.atan2(d[0], -d[2]) * 180 / Math.PI, n: __sky.xr.menu.rects.length }; })()")
    check('A folds the menu, A again brings it in front of where you look', (not folded['open']) and folded['ids'] == ['xr:show'] and back['open'] and abs(back['az'] - 53.13) < 0.5, f"menu at {back['az']:.1f} deg to the right, head turned 53.1 deg")
    ev("__t.look([0, 0, -1])"); frames(4); press('right', 'a-button'); press('right', 'a-button'); frames(6)

    # ---- hands: a pinch selects
    ev("__xrDevice.primaryInputMode = 'hand'"); frames(20)
    hs = ev("__sky.xr.pointers.filter((p) => p.source).map((p) => ({ hand: !!p.source.hand, mode: p.source.targetRayMode, h: p.source.handedness, joints: p.hand.children.length }))")
    arc = ev("__t.star('Arcturus')"); want = ev("s => __t.refDir(s.alt, s.az)", arc)
    # the ray of a hand is not its wrist's -z: aim, read the ray back, correct, twice
    ev("d => { const h = __xrDevice.hands.right; h.quaternion.set(...__t.quatOf(d)); h.position.set(0.25, 1.3, -0.3); }", want); frames(6)
    for _ in range(3):
        ev("""want => { const X = __sky.X, p = __t.pointer('right'), r = __t.ray(p.i).dir, h = __xrDevice.hands.right;
            const axis = X.cross(r, want), l = Math.hypot(...axis), ang = Math.atan2(l, X.dot(r, want)); if (l < 1e-12) return;
            const s = Math.sin(ang / 2) / l, q = [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(ang / 2)], o = [h.quaternion.x, h.quaternion.y, h.quaternion.z, h.quaternion.w];
            h.quaternion.set(q[3] * o[0] + q[0] * o[3] + q[1] * o[2] - q[2] * o[1], q[3] * o[1] - q[0] * o[2] + q[1] * o[3] + q[2] * o[0], q[3] * o[2] + q[0] * o[1] - q[1] * o[0] + q[2] * o[3], q[3] * o[3] - q[0] * o[0] - q[1] * o[1] - q[2] * o[2]); }""", want); frames(5)
    hsep = ev("want => __sky.X.angle(__t.ray(__t.pointer('right').i).dir, want) * 180 / Math.PI", want)
    sel0 = ev("__t.state().selects")
    ev("__xrDevice.hands.right.updatePinchValue(1)"); frames(6); ev("__xrDevice.hands.right.updatePinchValue(0)"); frames(6)
    hc = ev("({ title: __sky.xr.card.model && __sky.xr.card.model.title, selects: __t.state().selects })")
    check('hand tracking: both hands are input sources with joints', len(hs) == 2 and all(h['hand'] and h['mode'] == 'tracked-pointer' for h in hs), json.dumps(hs)[:160])
    check('a pinch selects the star the hand ray is on', hc['title'] == 'Arcturus' and hc['selects'] == sel0 + 1, f"{hc['title']}; hand ray {hsep:.3f} deg from Arcturus")
    shot('06-hand-pinch-arcturus', want)

    # ---- no controllers, no hands: gaze and dwell
    ev("(() => { const d = __xrDevice; d.primaryInputMode = 'controller'; d.controllers.left.connected = false; d.controllers.right.connected = false; if (d.hands.left) d.hands.left.connected = false; if (d.hands.right) d.hands.right.connected = false; __sky.S.selection = null; })()"); frames(20)
    nsrc = ev("__sky.xr.pointers.filter((p) => p.source).length")
    e0 = ev("__sky.S.layers.eqgrid")
    ev("__t.lookAt(__t.button('menu', 'layer:eqgrid'))"); frames(20)
    mid = ev("({ on: __sky.S.layers.eqgrid, vis: __sky.xr.pointers.every((p) => !p.line.visible) })")
    pg.wait_for_timeout(1600); frames(4); e1 = ev("__sky.S.layers.eqgrid"); pg.wait_for_timeout(1700); frames(4); e2 = ev("__sky.S.layers.eqgrid")
    check('gaze and dwell presses a menu button once', nsrc == 0 and mid['on'] == e0 and e1 != e0 and e2 == e1 and mid['vis'], f"no input sources; not yet after 20 frames, pressed after 1.3 s, not again after 3 s")
    ev("d => __t.look(d)", d); pg.wait_for_timeout(1800); frames(4)
    check('gaze and dwell on a star selects it', ev("__sky.xr.card.model && __sky.xr.card.model.title") == 'Vega')
    shot('07-gaze-dwell-vega')

    # ---- exit by the menu
    ev("(() => { const d = __xrDevice; d.controllers.left.connected = true; d.controllers.right.connected = true; __t.look([0, 0, -1]); })()"); frames(20)
    ev("__t.aimAt('right', __t.button('menu', 'xr:exit'))"); frames(4)
    ev("__xrDevice.controllers.right.updateButtonValue('trigger', 1)")       # the session ends on this press: no frames to wait for
    pg.wait_for_function("!__sky.xr.presenting", timeout=10000); pg.wait_for_timeout(700)
    ex = ev("({ mode: __sky.R.mode, presenting: __sky.R.renderer.xr.isPresenting, w: __sky.R.width, cw: document.getElementById('gl').clientWidth, group: __sky.xr.group.visible, sw: document.documentElement.scrollWidth, card: !document.getElementById('info').hidden, title: document.querySelector('#cardHead h2') && document.querySelector('#cardHead h2').textContent })")
    check('"Exit VR" ends the session and the flat page is back', (not ex['presenting']) and ex['mode'] == 'stereo' and ex['w'] == ex['cw'] and not ex['group'], f"canvas {ex['cw']} px, the page's card shows {ex['title']}")
    shot('08-flat-after-exit', clip_left=False)

    ev("__xrDevice.controllers.right.updateButtonValue('trigger', 0)")
    # ---- passthrough
    pg.click('#ptBtn')
    pg.wait_for_function("__sky.xr.presenting && __sky.xr.state.frames > 12", timeout=20000)
    ar = ev("({ kind: __sky.xr.state.kind, pass: __sky.frame().xr && __sky.frame().xr.passthrough, alpha: __sky.R.renderer.getClearAlpha(), blend: __xrDevice.activeSession.environmentBlendMode, ref: __sky.xr.state.refType })")
    check('passthrough session: no sky backdrop, a transparent clear', ar['kind'] == 'ar' and ar['pass'] and ar['alpha'] == 0, f"blend mode {ar['blend']}, reference space {ar['ref']}")
    d = ev("s => __t.refDir(s.alt, s.az)", ev("__t.star('Vega')"))       # the heading of this session is that of the flat view now
    ev("d => __t.aim('right', d, [0.25, 1.35, -0.25])", d); frames(8); press('right')
    check('passthrough: the trigger selects as in VR', ev("__sky.xr.card.model && __sky.xr.card.model.title") == 'Vega')
    shot('09-passthrough', [0.3, 0.25, -0.9])
    ev("__sky.xr.stop()"); pg.wait_for_function("!__sky.xr.presenting", timeout=10000); pg.wait_for_timeout(500)
    ev("__xrDevice.controllers.right.updateButtonValue('trigger', 0)")
    check('passthrough ended', ev("__sky.R.mode") == 'stereo' and ev("__sky.R.renderer.getClearAlpha()") == 1)

    bad = [e for e in errs if e.startswith('PAGEERROR') or e.startswith('console.error')]
    check('no page errors', not bad, '; '.join(bad[:3]))
    warn = [e for e in errs if e.startswith('console.warning')]
    if warn: print('warnings:', len(warn), '; '.join(sorted(set(w[:160] for w in warn))[:6]))
    b.close()
print('pictures in', OUT)
sys.exit(1 if fails else 0)
