#!/usr/bin/env python3
"""Checks that every level in js/levels.js can actually be finished.

The physics below is a frame-for-frame copy of step() and collide() in
js/game.js — same constants, same order of resolution, same tile lookups. From
the spawn point it searches forward through every reachable player state
(position, velocity, feet on the ground or not), choosing each frame between
running right, running right and jumping, and coasting. If no state ever
crosses the flagpole, the level cannot be finished and it says where the run
dries up.

    python3 tools/check_levels.py            # all levels
    python3 tools/check_levels.py 1-3        # just one

Exit status is non-zero if any level cannot be finished.
"""
import heapq, os, re, sys

# --- the engine's constants, verbatim (js/game.js) ---------------------------
GRAVITY, FRICTION, ACCEL, JUMP_IMPULSE = 1.0, 0.9, 0.5, 25.0
TS, PLAYER_W, PLAYER_H, BOX_TOP = 32, 32, 50, 18
DEATH_Y = 480 - 62
ROWS = 15
SOLID = set('#?b=[]<>x')       # '.', '|' and 'F' are passable
SPAWN = (224.0, 292.0)

# state quantisation for the visited set — fine enough not to skip a landing,
# coarse enough that the search stays in the tens of thousands of states
QX, QY, QV = 3.0, 3.0, 0.4


def solid(rows, cx, cy):
    """tileAt() + isSolid(): off the sides is wall, above and below is open air."""
    if cx < 0 or cx >= len(rows[0]):
        return True
    if cy < 0 or cy >= ROWS:
        return False
    return rows[cy][cx] in SOLID


def advance(rows, st, right, jump):
    """One frame of the engine. st is (x, y, sx, sy, on_ground)."""
    x, y, sx, sy, on_ground = st
    if jump and on_ground:
        sy -= JUMP_IMPULSE
        on_ground = False
    if right:
        sx += ACCEL
    prev_x = x
    sy += GRAVITY
    x += sx
    y += sy
    sx *= FRICTION
    sy *= FRICTION
    on_ground = False

    if sy >= 0:                                        # vertical first
        feet = int((y + PLAYER_H) // TS)
        if solid(rows, int((x + 8) // TS), feet) or solid(rows, int((x + 24) // TS), feet):
            y = feet * TS - PLAYER_H
            sy = 0.0
            on_ground = True
    else:
        head_col = int((x + 16) // TS)
        head_row = int((y + BOX_TOP) // TS)
        if solid(rows, head_col, head_row):
            y = (head_row + 1) * TS - BOX_TOP
            sy = 0.0

    row_top = int((y + BOX_TOP) // TS)                 # then horizontal
    row_bottom = int((y + PLAYER_H - 1) // TS)
    if sx > 0:
        cxr = int((x + PLAYER_W) // TS)
        if solid(rows, cxr, row_top) or solid(rows, cxr, row_bottom):
            x = prev_x
            sx = 0.0
    elif sx < 0:
        cxl = int(x // TS)
        if solid(rows, cxl, row_top) or solid(rows, cxl, row_bottom):
            x = prev_x
            sx = 0.0
    return (x, y, sx, sy, on_ground)


def key(st):
    return (int(st[0] / QX), int(st[1] / QY), int(st[2] / QV), int(st[3] / QV), st[4])


def search(rows, pole_col, limit=1500000):
    """Best-first over player states, driven toward the flagpole.

    Returns (reachable, furthest x, states examined). Exhausting the queue
    without reaching the pole is a proof that the level is unfinishable, up to
    the state quantisation."""
    goal_x = pole_col * TS
    start = (SPAWN[0], SPAWN[1], 0.0, 0.0, False)
    seen = {key(start)}
    queue = [(-start[0], 0, start)]
    tie = 0
    furthest = start[0]
    while queue and len(seen) < limit:
        st = heapq.heappop(queue)[2]
        for right, jump in ((True, False), (True, True), (False, False)):
            if jump and not st[4]:
                continue
            nxt = advance(rows, st, right, jump)
            if nxt[1] >= DEATH_Y:
                continue
            if nxt[0] + 16 >= goal_x:
                return True, nxt[0], len(seen)
            k = key(nxt)
            if k in seen:
                continue
            seen.add(k)
            furthest = max(furthest, nxt[0])
            tie += 1
            heapq.heappush(queue, (-nxt[0], tie, nxt))
    return False, furthest, len(seen)


# --- advisory geometry lint --------------------------------------------------
def ledges(rows):
    """Runs of tiles the player can stand on with room to fit above."""
    segs = []
    for y in range(2, ROWS):
        for x in range(len(rows[0])):
            if rows[y][x] in SOLID and rows[y-1][x] not in SOLID and rows[y-2][x] not in SOLID:
                if segs and segs[-1][0] == y and segs[-1][2] == x - 1:
                    segs[-1][2] = x
                else:
                    segs.append([y, x, x])
    return [tuple(s) for s in segs]


def lint(rows):
    """Cheap warnings about the shapes that historically broke this game."""
    notes = []
    cols = len(rows[0])
    # a pit wider than four tiles cannot be jumped even at full speed
    run = start = 0
    for x in range(cols + 1):
        empty = x < cols and not any(rows[y][x] in SOLID for y in range(ROWS))
        if empty:
            if not run:
                start = x
            run += 1
        elif run:
            if run > 4:
                notes.append('columns %d-%d are a %d-tile hole; 4 is the most a '
                             'running jump clears' % (start, start + run - 1, run))
            run = 0
    # a ceiling closer than five rows above a ledge cuts a jump short, which
    # only matters where the player has to jump off the end of that ledge
    for row, x0, x1 in ledges(rows):
        after = x1 + 1
        if after >= cols:
            continue
        if any(rows[y][after] in SOLID for y in range(row, ROWS)):
            continue                       # solid ground beyond, no jump needed
        for x in range(max(x0, x1 - 3), x1 + 1):
            hit = next((y for y in range(row - 1, max(-1, row - 5), -1)
                        if rows[y][x] in SOLID), None)
            if hit is not None:
                notes.append('the ledge on row %d ending at column %d has to be '
                             'jumped off, but a ceiling %d rows above it (row %d) '
                             'cuts the jump short' % (row, x1, row - hit, hit))
                break
    return notes


def read_levels(path):
    src = open(path, encoding='utf-8').read()
    out = []
    for lid, body in re.findall(r"\{\s*id:\s*'([^']+)'.*?rows:\s*\[(.*?)\]\s*\}", src, re.S):
        out.append((lid, re.findall(r"'([^']*)'", body)))
    return out


def main():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    levels = read_levels(os.path.join(here, 'js', 'levels.js'))
    if not levels:
        sys.exit('no levels found in js/levels.js')
    wanted = set(sys.argv[1:])
    bad = 0
    for lid, rows in levels:
        if wanted and lid not in wanted:
            continue
        widths = {len(r) for r in rows}
        print('%-4s %2d rows x %3d cols' % (lid, len(rows), len(rows[0])), end='')
        if len(rows) != ROWS or len(widths) != 1:
            print('\n   ERROR: every row must be the same width and there must be'
                  ' %d of them (got widths %s)' % (ROWS, sorted(widths)))
            bad += 1
            continue
        pole = next((r.find('|') for r in rows if '|' in r), -1)
        if pole < 0:
            print('\n   ERROR: no flagpole')
            bad += 1
            continue
        ok, furthest, states = search(rows, pole)
        print('   coins %3d   states %6d' % (sum(r.count('?') for r in rows), states), end='')
        if ok:
            print('   finishable   OK')
        else:
            print('\n   ERROR: the flagpole cannot be reached; nothing gets past '
                  'x=%.0f (column %d of %d)' % (furthest, furthest / TS, len(rows[0])))
            bad += 1
        for n in lint(rows):
            print('   note: %s' % n)
    print()
    print('%d level(s) cannot be finished.' % bad if bad else 'All levels can be finished.')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
