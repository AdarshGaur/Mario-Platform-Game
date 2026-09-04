/*  game.js — engine for the Mario platform game.
 *
 *  Everything is drawn onto one 1200x480 canvas (37.5 x 15 tiles of 32px).
 *  The level itself is a flat array of tile ids; see levels.js for the data
 *  and for the design rules the physics below imply.
 *
 *  Physics is deliberately unchanged from the original single-level version:
 *    gravity +1/frame, friction *0.9, accel 0.5/frame, jump impulse -25.
 *  Those four numbers give a 124px apex and a 160px running jump, which is
 *  what every level is built around — changing them invalidates the levels.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------ constants */
  var TS = 32;                     // tile size
  var VIEW_W = 1200, VIEW_H = 480;
  var GRAVITY = 1, FRICTION = 0.9, ACCEL = 0.5, JUMP_IMPULSE = 25;
  var PLAYER_W = 32, PLAYER_H = 50;
  var BOX_TOP = 18;                // collision box starts 18px below the sprite top
  var DEATH_Y = VIEW_H - 62;       // fall past this and you are gone
  var START_LIVES = 3;
  var TIME_TICK_MS = 400;          // one unit of the clock
  var POINTS_COIN = 100, POINTS_CLEAR = 1000, POINTS_PER_TIME = 10;
  var STORE_KEY = 'mario-platform-game/v1';

  /* Source rectangles inside img/spritesheet.png */
  var SRC = {
    sky:     [48, 336, 15, 15],
    ground:  [0, 0, 16, 16],
    coin:    [384, 0, 16, 16],
    brick:   [16, 0, 16, 16],
    stair:   [0, 16, 16, 16],
    used:    [48, 0, 16, 16],
    pole:    [257, 145, 15, 15],
    pipeL:   [0, 144, 15, 15],
    pipeR:   [16, 144, 16, 16],
    pipeTL:  [0, 128, 16, 16],
    pipeTR:  [16, 128, 16, 16]
  };

  /* Frames inside img/mario-sprites.png (all 32x50) */
  var MARIO = {
    standRight: 0, standLeft: 255,
    runRight: [0, 30], runLeft: [255, 290],
    jumpRight: 95, jumpLeft: 65,
    climb: 385
  };

  /* ------------------------------------------------------------ dom + state */
  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  canvas.width = VIEW_W;
  canvas.height = VIEW_H;

  var el = {
    score:   document.getElementById('hud-score'),
    coins:   document.getElementById('hud-coins'),
    world:   document.getElementById('hud-world'),
    lives:   document.getElementById('hud-lives'),
    time:    document.getElementById('hud-time'),
    overlay: document.getElementById('overlay'),
    mute:    document.getElementById('mute-btn')
  };

  var game = {
    state: 'loading',      // loading | menu | playing | sliding | cleared | dead | gameover | won | paused
    level: null,           // decoded level
    levelIndex: 0,
    score: 0,
    coins: 0,
    lives: START_LIVES,
    time: 0,
    lastTick: 0,
    cameraX: 0,
    flagY: 1,              // row the flag is drawn at, animates on clear
    seqTimer: 0,
    muted: false
  };

  var player = {
    x: 0, y: 0, previousX: 0, previousY: 0,
    speedX: 0, speedY: 0,
    onGround: false, faceRight: true,
    frame: MARIO.standRight, animTick: 0
  };

  var keys = {};
  var touchHeld = { left: false, right: false, jump: false };

  /* ------------------------------------------------------------ persistence */
  function loadStore() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }
  function saveStore(patch) {
    try {
      var s = loadStore();
      for (var k in patch) s[k] = patch[k];
      localStorage.setItem(STORE_KEY, JSON.stringify(s));
    } catch (e) { /* private mode — progress just won't persist */ }
  }
  var store = loadStore();
  var unlocked = Math.min(Math.max(store.unlocked || 1, 1), LEVELS.length);
  var bestScore = store.best || 0;
  game.muted = !!store.muted;

  /* ------------------------------------------------------------ assets */
  var images = {};
  var sounds = {};
  var skyPattern = null;

  function loadAssets(done) {
    var srcs = {
      tiles: 'img/spritesheet.png',
      mario: 'img/mario-sprites.png',
      flag:  'img/flag.png'
    };
    var pending = 0, failed = false;
    for (var key in srcs) {
      pending++;
      (function (k, src) {
        var img = new Image();
        img.onload = function () { if (!--pending) done(failed); };
        img.onerror = function () { failed = true; if (!--pending) done(failed); };
        img.src = src;
        images[k] = img;
      })(key, srcs[key]);
    }

    var audioSrc = {
      bg: 'audio/bgsound.mp3', jump: 'audio/jump.wav', coin: 'audio/coin.wav',
      clear: 'audio/stage-clear.wav', die: 'audio/mario-die.wav'
    };
    for (var a in audioSrc) {
      var au = new Audio();
      au.preload = 'auto';
      au.src = audioSrc[a];
      sounds[a] = au;
    }
    sounds.bg.loop = true;
    sounds.bg.volume = 0.35;
  }

  function play(name) {
    if (game.muted) return;
    var s = sounds[name];
    if (!s) return;
    try { s.currentTime = 0; } catch (e) {}
    var p = s.play();
    if (p && p.catch) p.catch(function () {});   // autoplay blocked — not fatal
  }
  function music(on) {
    if (on && !game.muted) {
      var p = sounds.bg.play();
      if (p && p.catch) p.catch(function () {});
    } else {
      sounds.bg.pause();
    }
  }
  function setMuted(m) {
    game.muted = m;
    saveStore({ muted: m });
    el.mute.textContent = m ? 'Sound: off' : 'Sound: on';
    el.mute.setAttribute('aria-pressed', String(m));
    if (m) { sounds.bg.pause(); }
    else if (game.state === 'playing') music(true);
  }

  /* ------------------------------------------------------------ tiles */
  function tileAt(cx, cy) {
    var lv = game.level;
    if (cx < 0 || cx >= lv.cols) return TILE.GROUND;   // walls at both ends
    if (cy < 0) return TILE.SKY;
    if (cy >= lv.rows) return TILE.SKY;                // the void below
    return lv.map[cy * lv.cols + cx];
  }
  function setTile(cx, cy, t) {
    var lv = game.level;
    if (cx >= 0 && cx < lv.cols && cy >= 0 && cy < lv.rows) lv.map[cy * lv.cols + cx] = t;
  }
  function isSolid(t) {
    return t !== TILE.SKY && t !== TILE.POLE && t !== TILE.FLAG;
  }

  /* ------------------------------------------------------------ level flow */
  /* The URL hash names the level, so a level is linkable and a refresh
   * keeps you where you were: index.html#1-3 */
  var suppressHash = false;
  function levelFromHash() {
    var h = (location.hash || '').replace(/^#/, '').trim();
    for (var i = 0; i < LEVELS.length; i++) if (LEVELS[i].id === h) return i;
    return -1;
  }
  function writeHash(id) {
    if (location.hash.slice(1) === id) return;
    suppressHash = true;
    location.hash = id;
  }
  window.addEventListener('hashchange', function () {
    if (suppressHash) { suppressHash = false; return; }
    var i = levelFromHash();
    if (i >= 0 && i !== game.levelIndex) startRun(i);
  });

  function startLevel(index) {
    game.levelIndex = index;
    game.level = decodeLevel(LEVELS[index]);
    game.time = game.level.time;
    game.lastTick = performance.now();
    game.cameraX = 0;
    game.flagY = 1;
    game.seqTimer = 0;
    resetPlayer();
    game.state = 'playing';
    writeHash(game.level.id);
    hideOverlay();
    updateHud();
    music(true);
  }

  function resetPlayer() {
    var sp = game.level.spawn;
    player.x = sp.x; player.y = sp.y;
    player.previousX = sp.x; player.previousY = sp.y;
    player.speedX = 0; player.speedY = 0;
    player.onGround = false; player.faceRight = true;
    player.frame = MARIO.standRight;
  }

  function die() {
    if (game.state !== 'playing') return;
    game.state = 'dead';
    game.seqTimer = 0;
    music(false);
    play('die');
    game.lives--;
    player.speedY = -14;              // the classic little death hop
  }

  function afterDeath() {
    if (game.lives > 0) {
      startLevel(game.levelIndex);
    } else {
      game.state = 'gameover';
      recordBest();
      showGameOver();
    }
  }

  function completeLevel() {
    game.state = 'sliding';
    game.seqTimer = 0;
    player.speedX = 0;
    player.x = game.level.poleX - 16;
    player.frame = MARIO.climb;
    music(false);
    play('clear');
  }

  function finishLevel() {
    var bonus = Math.max(0, Math.floor(game.time)) * POINTS_PER_TIME;
    game.score += POINTS_CLEAR + bonus;
    if (game.levelIndex + 1 < LEVELS.length) {
      unlocked = Math.max(unlocked, game.levelIndex + 2);
      saveStore({ unlocked: unlocked });
      game.state = 'cleared';
      showCleared(bonus);
    } else {
      unlocked = LEVELS.length;
      saveStore({ unlocked: unlocked });
      game.state = 'won';
      recordBest();
      showVictory();
    }
    updateHud();
  }

  function recordBest() {
    if (game.score > bestScore) {
      bestScore = game.score;
      saveStore({ best: bestScore });
    }
  }

  /* ------------------------------------------------------------ input */
  var KEY_LEFT = { ArrowLeft: 1, KeyA: 1 };
  var KEY_RIGHT = { ArrowRight: 1, KeyD: 1 };
  var KEY_JUMP = { ArrowUp: 1, KeyW: 1, Space: 1 };

  function held(map) {
    for (var code in map) if (keys[code]) return true;
    return false;
  }
  function wantLeft()  { return held(KEY_LEFT) || touchHeld.left; }
  function wantRight() { return held(KEY_RIGHT) || touchHeld.right; }
  function wantJump()  { return held(KEY_JUMP) || touchHeld.jump; }

  window.addEventListener('keydown', function (e) {
    if (e.code === 'Space' || e.code.indexOf('Arrow') === 0) e.preventDefault();
    keys[e.code] = true;
    if (e.code === 'KeyM') setMuted(!game.muted);
    if (e.code === 'KeyP' || e.code === 'Escape') togglePause();
    if (e.code === 'KeyR' && (game.state === 'playing' || game.state === 'paused')) {
      game.lives--;
      if (game.lives > 0) startLevel(game.levelIndex);
      else { game.state = 'gameover'; recordBest(); showGameOver(); }
    }
    if (e.code === 'Enter') {
      if (game.state === 'menu') startRun(0);
      else if (game.state === 'cleared') startLevel(game.levelIndex + 1);
      else if (game.state === 'gameover' || game.state === 'won') showMenu();
    }
  });
  window.addEventListener('keyup', function (e) { keys[e.code] = false; });
  window.addEventListener('blur', function () {
    for (var k in keys) keys[k] = false;      // clear in place: other code holds this object
  });

  function bindTouch(id, prop) {
    var b = document.getElementById(id);
    if (!b) return;
    var set = function (v) { return function (ev) { ev.preventDefault(); touchHeld[prop] = v; }; };
    b.addEventListener('touchstart', set(true), { passive: false });
    b.addEventListener('touchend', set(false), { passive: false });
    b.addEventListener('touchcancel', set(false), { passive: false });
    b.addEventListener('mousedown', set(true));
    b.addEventListener('mouseup', set(false));
    b.addEventListener('mouseleave', set(false));
  }
  bindTouch('btn-left', 'left');
  bindTouch('btn-right', 'right');
  bindTouch('btn-jump', 'jump');

  function togglePause() {
    if (game.state === 'playing') {
      game.state = 'paused';
      music(false);
      showPause();
    } else if (game.state === 'paused') {
      game.state = 'playing';
      game.lastTick = performance.now();
      hideOverlay();
      music(true);
    }
  }

  /* ------------------------------------------------------------ simulation */
  function step(now) {
    if (game.state === 'dead') {
      game.seqTimer++;
      player.speedY += GRAVITY;
      player.y += player.speedY;
      player.speedY *= FRICTION;
      if (game.seqTimer > 80) afterDeath();
      return;
    }
    if (game.state === 'sliding') {
      game.seqTimer++;
      var groundTop = groundRowUnder(game.level.poleCol) * TS;
      game.flagY = Math.min(10, game.flagY + 0.16);
      if (player.y + PLAYER_H < groundTop) player.y += 4;
      else if (game.seqTimer > 60) finishLevel();
      return;
    }
    if (game.state !== 'playing') return;

    /* clock */
    while (now - game.lastTick >= TIME_TICK_MS) {
      game.lastTick += TIME_TICK_MS;
      game.time--;
      if (game.time <= 0) { game.time = 0; updateHud(); die(); return; }
      updateHud();
    }

    /* horizontal input */
    if (wantLeft()) {
      player.speedX -= ACCEL;
      player.faceRight = false;
      player.animTick++;
    }
    if (wantRight()) {
      player.speedX += ACCEL;
      player.faceRight = true;
      player.animTick++;
    }
    if (wantJump() && player.onGround) {
      player.speedY -= JUMP_IMPULSE;
      player.onGround = false;
      play('jump');
    }

    player.previousX = player.x;
    player.previousY = player.y;

    player.speedY += GRAVITY;
    player.x += player.speedX;
    player.y += player.speedY;
    player.speedX *= FRICTION;
    player.speedY *= FRICTION;

    player.onGround = false;
    collide();

    if (player.x + 16 >= game.level.poleX) { completeLevel(); return; }
    if (player.y >= DEATH_Y) { die(); return; }

    chooseFrame();
  }

  /* Which row of solid ground sits under a column (used by the pole slide). */
  function groundRowUnder(cx) {
    for (var y = 0; y < game.level.rows; y++) if (isSolid(tileAt(cx, y))) return y;
    return game.level.rows;
  }

  /*  Collision resolution.
   *  The player's box is 32 wide and 32 tall, sitting at the bottom of the
   *  50px sprite: x .. x+32 horizontally, y+18 .. y+50 vertically. */
  function collide() {
    /*  Vertical first, then horizontal, and that order matters: gravity pushes
     *  the player a pixel into the floor every frame, so resolving sideways
     *  first would see the floor as a wall the box is touching and refuse to
     *  let him walk. Landing snaps him back out, and only then is the box in
     *  the right place to ask what is beside him. */

    if (player.speedY >= 0) {
      /* landing: either bottom corner over a solid tile */
      var feetRow = Math.floor((player.y + PLAYER_H) / TS);
      var footL = Math.floor((player.x + 8) / TS);
      var footR = Math.floor((player.x + 24) / TS);
      if (isSolid(tileAt(footL, feetRow)) || isSolid(tileAt(footR, feetRow))) {
        player.y = feetRow * TS - PLAYER_H;
        player.speedY = 0;
        player.onGround = true;
      }
    } else {
      /* head: the tile the top of the box has risen into */
      var headCol = Math.floor((player.x + 16) / TS);
      var headRow = Math.floor((player.y + BOX_TOP) / TS);
      var above = tileAt(headCol, headRow);
      if (isSolid(above)) {
        player.y = (headRow + 1) * TS - BOX_TOP;
        player.speedY = 0;
        if (above === TILE.COIN) {
          setTile(headCol, headRow, TILE.USED);
          game.coins++;
          game.score += POINTS_COIN;
          play('coin');
          updateHud();
        }
      }
    }

    /* sideways: check both tile rows the 32x32 box spans, then undo the move */
    var rowTop = Math.floor((player.y + BOX_TOP) / TS);
    var rowBottom = Math.floor((player.y + PLAYER_H - 1) / TS);
    if (player.speedX > 0) {
      var cxR = Math.floor((player.x + PLAYER_W) / TS);
      if (isSolid(tileAt(cxR, rowTop)) || isSolid(tileAt(cxR, rowBottom))) {
        player.x = player.previousX;
        player.speedX = 0;
      }
    } else if (player.speedX < 0) {
      var cxL = Math.floor(player.x / TS);
      if (isSolid(tileAt(cxL, rowTop)) || isSolid(tileAt(cxL, rowBottom))) {
        player.x = player.previousX;
        player.speedX = 0;
      }
    }
  }

  function chooseFrame() {
    if (!player.onGround) {
      player.frame = player.faceRight ? MARIO.jumpRight : MARIO.jumpLeft;
    } else if (Math.abs(player.speedX) > 0.4) {
      var f = Math.floor(player.animTick / 6) % 2;
      player.frame = player.faceRight ? MARIO.runRight[f] : MARIO.runLeft[f];
    } else {
      player.frame = player.faceRight ? MARIO.standRight : MARIO.standLeft;
    }
  }

  /* ------------------------------------------------------------ drawing */
  function makeSkyPattern() {
    var c = document.createElement('canvas');
    c.width = TS; c.height = TS;
    var g = c.getContext('2d');
    g.drawImage(images.tiles, SRC.sky[0], SRC.sky[1], SRC.sky[2], SRC.sky[3], 0, 0, TS, TS);
    skyPattern = ctx.createPattern(c, 'repeat');
  }

  function drawTile(src, x, y) {
    ctx.drawImage(images.tiles, src[0], src[1], src[2], src[3], x * TS, y * TS, TS, TS);
  }

  function render() {
    var lv = game.level;

    /* camera: keep the player ~40% from the left, clamped to the level */
    var target = player.x - VIEW_W * 0.4;
    game.cameraX = Math.max(0, Math.min(target, lv.width - VIEW_W));

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = skyPattern || '#5c94fc';
    ctx.save();
    ctx.translate(-(game.cameraX % TS), 0);
    ctx.fillRect(0, 0, VIEW_W + TS, VIEW_H);
    ctx.restore();

    ctx.translate(-Math.round(game.cameraX), 0);

    var first = Math.max(0, Math.floor(game.cameraX / TS));
    var last = Math.min(lv.cols - 1, Math.ceil((game.cameraX + VIEW_W) / TS));

    for (var x = first; x <= last; x++) {
      for (var y = 0; y < lv.rows; y++) {
        var t = lv.map[y * lv.cols + x];
        switch (t) {
          case TILE.GROUND:  drawTile(SRC.ground, x, y); break;
          case TILE.COIN:    drawTile(SRC.coin, x, y); break;
          case TILE.BRICK:   drawTile(SRC.brick, x, y); break;
          case TILE.STAIR:   drawTile(SRC.stair, x, y); break;
          case TILE.USED:    drawTile(SRC.used, x, y); break;
          case TILE.POLE:    drawTile(SRC.pole, x, y); break;
          case TILE.PIPE_L:  drawTile(SRC.pipeL, x, y); break;
          case TILE.PIPE_R:  drawTile(SRC.pipeR, x, y); break;
          case TILE.PIPE_TL: drawTile(SRC.pipeTL, x, y); break;
          case TILE.PIPE_TR: drawTile(SRC.pipeTR, x, y); break;
          case TILE.FLAG:
            ctx.drawImage(images.flag, 0, 0, 32, 32,
                          x * TS + 10, game.flagY * TS, TS, TS);
            break;
        }
      }
    }

    ctx.drawImage(images.mario, player.frame, 0, 32, PLAYER_H,
                  Math.round(player.x), Math.round(player.y), PLAYER_W, PLAYER_H);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /* ------------------------------------------------------------ hud + screens */
  function updateHud() {
    el.score.textContent = String(game.score).padStart(6, '0');
    el.coins.textContent = String(game.coins).padStart(2, '0');
    el.world.textContent = game.level ? game.level.id : '—';
    el.lives.textContent = 'x' + Math.max(0, game.lives);
    el.time.textContent = String(Math.max(0, game.time)).padStart(3, '0');
  }

  function hideOverlay() {
    el.overlay.hidden = true;
    el.overlay.innerHTML = '';
  }
  function showOverlay(html, cls) {
    el.overlay.className = 'overlay' + (cls ? ' ' + cls : '');
    el.overlay.innerHTML = '<div class="panel">' + html + '</div>';
    el.overlay.hidden = false;
  }

  function levelPickerHtml() {
    var out = '<div class="levels">';
    for (var i = 0; i < LEVELS.length; i++) {
      var lock = i + 1 > unlocked;
      out += '<button class="lvl" data-level="' + i + '"' + (lock ? ' disabled' : '') + '>' +
             '<span class="lvl-id">' + LEVELS[i].id + '</span>' +
             '<span class="lvl-name">' + (lock ? 'Locked' : LEVELS[i].name) + '</span>' +
             '</button>';
    }
    return out + '</div>';
  }

  function showMenu() {
    game.state = 'menu';
    music(false);
    showOverlay(
      '<img src="img/logo.png" alt="" class="logo">' +
      '<h1>Mario</h1>' +
      '<p class="sub">' + LEVELS.length + ' levels of vanilla-JavaScript platforming</p>' +
      '<button class="primary" id="play-btn">Start Game</button>' +
      '<p class="hint">or pick a level</p>' +
      levelPickerHtml() +
      '<p class="best">Best score: ' + bestScore + '</p>' +
      '<p class="keys">&larr; &rarr; move &nbsp;·&nbsp; &uarr; / space jump &nbsp;·&nbsp; ' +
      'P pause &nbsp;·&nbsp; R restart level &nbsp;·&nbsp; M sound</p>',
      'menu');
  }

  function showPause() {
    showOverlay('<h2>Paused</h2>' +
                '<button class="primary" id="resume-btn">Resume</button>' +
                '<button id="menu-btn">Quit to menu</button>');
  }

  function showCleared(bonus) {
    showOverlay('<h2>' + game.level.id + ' cleared</h2>' +
                '<table class="tally">' +
                '<tr><td>Time bonus</td><td>' + bonus + '</td></tr>' +
                '<tr><td>Level clear</td><td>' + POINTS_CLEAR + '</td></tr>' +
                '<tr class="total"><td>Score</td><td>' + game.score + '</td></tr>' +
                '</table>' +
                '<button class="primary" id="next-btn">Next: ' +
                LEVELS[game.levelIndex + 1].name + '</button>' +
                '<button id="menu-btn">Quit to menu</button>');
  }

  function showGameOver() {
    showOverlay('<h2>Game Over</h2>' +
                '<p class="sub">You reached ' + game.level.id + ' — ' + game.level.name + '</p>' +
                '<p class="score-big">' + game.score + '</p>' +
                '<button class="primary" id="retry-btn">Try again</button>' +
                '<button id="menu-btn">Menu</button>');
  }

  function showVictory() {
    showOverlay('<h2>You beat every level!</h2>' +
                '<p class="score-big">' + game.score + '</p>' +
                '<p class="sub">Best: ' + bestScore + '</p>' +
                '<button class="primary" id="menu-btn">Back to menu</button>',
                'menu');
  }

  el.overlay.addEventListener('click', function (e) {
    var t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'play-btn') startRun(0);
    else if (t.id === 'next-btn') startLevel(game.levelIndex + 1);
    else if (t.id === 'resume-btn') togglePause();
    else if (t.id === 'retry-btn') startRun(game.levelIndex);
    else if (t.id === 'menu-btn') showMenu();
    else if (t.dataset.level !== undefined) startRun(parseInt(t.dataset.level, 10));
  });
  el.mute.addEventListener('click', function () { setMuted(!game.muted); });

  function startRun(index) {
    unlocked = Math.max(unlocked, index + 1);
    saveStore({ unlocked: unlocked });
    game.score = 0;
    game.coins = 0;
    game.lives = START_LIVES;
    startLevel(index);
  }

  /* ------------------------------------------------------------ main loop */
  function frame(now) {
    step(now);
    if (game.level) render();
    requestAnimationFrame(frame);
  }

  /*  Debug handle. Handy from the console (MarioGame.player.x, MarioGame.start(2))
   *  and it is what tools/playtest.py drives to verify every level is beatable. */
  window.MarioGame = {
    game: game, player: player, keys: keys, levels: LEVELS,
    get state() { return game.state; },
    get level() { return game.level; },
    solid: function (cx, cy) { return isSolid(tileAt(cx, cy)); },
    start: startRun
  };

  loadAssets(function (failed) {
    if (failed) {
      showOverlay('<h2>Assets failed to load</h2><p class="sub">Serve the folder over HTTP ' +
                  '(see the README) rather than opening index.html from a zip.</p>');
      return;
    }
    makeSkyPattern();
    game.level = decodeLevel(LEVELS[0]);   // so something is on screen behind the menu
    game.time = game.level.time;
    resetPlayer();
    setMuted(game.muted);
    updateHud();
    requestAnimationFrame(frame);

    var deep = levelFromHash();
    if (deep >= 0) startRun(deep);
    else showMenu();
  });
})();
