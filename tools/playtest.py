#!/usr/bin/env python3
"""Plays every level with a simple bot and reports whether each one can be finished.

Drives a headless Chromium over the DevTools protocol: a script injected into the
page holds "right" and jumps whenever the tile ahead is a wall or a hole, which is
all a level built inside the design envelope in js/levels.js should ever need.

    python3 -m http.server 8877 &
    python3 tools/playtest.py
"""
import asyncio, json, subprocess, sys, time, urllib.request
import websockets

BASE = 'http://localhost:8877/index.html'
PORT = 9333

BOT = r"""
(function () {
  if (window.__bot) return 'already';
  var g = window.MarioGame;
  var st = { maxX: 0, frames: 0, stuck: 0, lastX: -1, done: null };
  window.__bot = st;
  function tick() {
    requestAnimationFrame(tick);
    var p = g.player, lv = g.level;
    if (g.state === 'cleared' || g.state === 'won') { st.done = 'cleared'; return; }
    if (g.state === 'gameover') { st.done = 'gameover'; return; }
    if (g.state !== 'playing') return;
    st.frames++;
    st.maxX = Math.max(st.maxX, p.x);
    if (Math.abs(p.x - st.lastX) < 0.4) st.stuck++; else st.stuck = 0;
    st.lastX = p.x;
    var col = Math.floor((p.x + 16) / 32);
    var feet = Math.floor((p.y + 50) / 32);
    // Jump early at a wall, but at a ledge wait for the very lip: leaving a
    // tile and a half of platform behind turns a 3-tile gap into a 5-tile one.
    // And only for a real hole — a step down onto ground further below is
    // walked off, not jumped, or the arc sails over the safe ground beyond.
    var wall = g.solid(col + 1, feet - 1) || g.solid(col + 2, feet - 1);
    var lip = Math.floor((p.x + 38) / 32);
    var hole = true;
    for (var y = feet; y < lv.rows; y++) {
      if (g.solid(lip, y)) { hole = false; break; }
    }
    g.keys.ArrowRight = true;
    g.keys.ArrowUp = (wall || hole || st.stuck > 20) && p.onGround;
  }
  requestAnimationFrame(tick);
  return 'started';
})()
"""


async def rpc(ws, method, params=None, _id=[0]):
    _id[0] += 1
    await ws.send(json.dumps({'id': _id[0], 'method': method, 'params': params or {}}))
    while True:
        msg = json.loads(await ws.recv())
        if msg.get('id') == _id[0]:
            return msg


async def evaluate(ws, expr):
    r = await rpc(ws, 'Runtime.evaluate',
                  {'expression': expr, 'returnByValue': True, 'awaitPromise': True})
    res = r.get('result', {}).get('result', {})
    if r.get('result', {}).get('exceptionDetails'):
        raise RuntimeError(json.dumps(r['result']['exceptionDetails'])[:400])
    return res.get('value')


def target_ws():
    for _ in range(60):
        try:
            pages = json.loads(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json').read())
            for p in pages:
                if p.get('type') == 'page' and p.get('webSocketDebuggerUrl'):
                    return p['webSocketDebuggerUrl']
        except Exception:
            pass
        time.sleep(0.25)
    raise SystemExit('could not reach the browser on the debugging port')


async def play(level_id, timeout=90):
    proc = subprocess.Popen(
        ['chromium', '--headless=new', '--no-sandbox', '--disable-gpu', '--mute-audio',
         f'--remote-debugging-port={PORT}', '--window-size=1240,560',
         f'{BASE}#{level_id}'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        url = target_ws()
        async with websockets.connect(url, max_size=None) as ws:
            await rpc(ws, 'Runtime.enable')
            for _ in range(80):
                if await evaluate(ws, "!!(window.MarioGame && window.MarioGame.level)"):
                    break
                await asyncio.sleep(0.25)
            await evaluate(ws, BOT)
            deadline = time.time() + timeout
            while time.time() < deadline:
                await asyncio.sleep(0.5)
                st = await evaluate(ws, "JSON.stringify(window.__bot)")
                st = json.loads(st)
                if st['done']:
                    lv = await evaluate(ws, "MarioGame.level.width")
                    return st['done'], st, lv
            lv = await evaluate(ws, "MarioGame.level.width")
            return 'timeout', st, lv
    finally:
        proc.terminate()
        proc.wait(timeout=10)


async def main():
    ids = sys.argv[1:] or ['1-1', '1-2', '1-3', '1-4', '1-5']
    bad = 0
    for lid in ids:
        outcome, st, width = await play(lid)
        pct = 100.0 * st['maxX'] / max(1, width)
        flag = 'PASS' if outcome == 'cleared' else 'FAIL'
        if outcome != 'cleared':
            bad += 1
        print(f'{flag}  {lid}: {outcome:9s} reached {st["maxX"]:7.0f}px of {width}px '
              f'({pct:5.1f}%) in {st["frames"]} frames')
    sys.exit(1 if bad else 0)


asyncio.run(main())
