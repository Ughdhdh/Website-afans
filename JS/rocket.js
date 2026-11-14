/* AvakyanDrop: «Самолёт» (crash-игра на виртуальные баллы).
   Игра запускается кнопкой «Запуск», у каждого игрока своя. Ведёт её сервер (rocket_launch / rocket_cashout / rocket_state).
   Точка падения известна только серверу и раскрывается после конца игры, подделать её из браузера нельзя.
   Здесь только рисование и кнопки. Гости могут запускать демо-полёт без ставки (считается в браузере). */
(function () {
  'use strict';
  if (!document.getElementById('rkCanvas') || !window.Ava) return;

  // ===================== НАСТРОЙКИ (меняйте здесь) =====================
  var PLANE = {
    src: 'img/plane.png',   // ваша картинка: PNG с прозрачным фоном (или SVG), самолёт смотрит носом ВПРАВО
    width: 120,             // ширина самолёта на экране (px) на компьютере; на телефоне уменьшается сама
    angleOffset: 0          // если ваша картинка повёрнута, поправьте угол (в радианах, например -0.3)
  };
  var WOBBLE = {
    amp: 0.09,              // размах покачивания вверх-вниз (доля высоты сцены); 0 = летит ровно по кривой
    f1: 1.1, f2: 2.3        // частоты покачивания
  };
  // =====================================================================

  var $ = function (id) { return document.getElementById(id); };
  var stage = $('rkStage'), canvas = $('rkCanvas'), ctx = canvas.getContext('2d');
  var multEl = $('rkMult'), subEl = $('rkSub');
  var histEl = $('rkHistory'), betsEl = $('rkBets'), msgEl = $('rkMsg');

  var planeImg = new Image();
  planeImg.src = PLANE.src;

  var game = null;            // текущая или последняя игра {id, status, amount, auto, mult, payout, crash_point, start, demo}
  var offset = 0;             // server_now - Date.now()
  var growth = 0.12;
  var polling = false, pollTimer = null, pokedAuto = false;
  var lastHist = '';
  var busy = false;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function floor2(x) { return Math.floor(x * 100 + 1e-9) / 100; }
  function fmt(n) { return Number(n).toFixed(2); }
  var UNIT = ' б.';
  function serverNow() { return Date.now() + offset; }

  function setMsg(text, info) {
    msgEl.textContent = text || '';
    msgEl.style.color = info ? 'var(--muted)' : '';
  }
  function load(key, def) { try { var v = localStorage.getItem(key); return v === null ? def : JSON.parse(v); } catch (e) { return def; } }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }

  // ======================= панель ставки =======================
  var panel = (function () {
    var root = el('div', 'bet');

    var top = el('div', 'bet-top');
    var lAuto = el('label'); var cbAuto = el('input'); cbAuto.type = 'checkbox';
    lAuto.appendChild(cbAuto); lAuto.appendChild(document.createTextNode('Автовывод'));
    var av = el('span', 'auto-val'); av.appendChild(document.createTextNode('x'));
    var inAuto = el('input'); inAuto.type = 'number'; inAuto.min = '1.01'; inAuto.step = '0.01'; inAuto.inputMode = 'decimal';
    av.appendChild(inAuto);
    top.appendChild(lAuto); top.appendChild(av);

    var main = el('div', 'bet-main');
    var box = el('div', 'amount-box');
    var amount = el('div', 'amount');
    var bMinus = el('button', '', '−'); bMinus.type = 'button';
    var inAmt = el('input'); inAmt.type = 'number'; inAmt.min = '0.01'; inAmt.max = '1000'; inAmt.step = '0.01'; inAmt.inputMode = 'decimal';
    var bPlus = el('button', '', '+'); bPlus.type = 'button';
    amount.appendChild(bMinus); amount.appendChild(inAmt); amount.appendChild(bPlus);
    var quick = el('div', 'quick');
    [['+0.01', 0.01], ['+0.02', 0.02], ['+0.05', 0.05], ['+0.10', 0.10]].forEach(function (q) {
      var b = el('button', '', q[0]); b.type = 'button';
      b.addEventListener('click', function () { setAmt(readAmt() + q[1]); });
      quick.appendChild(b);
    });
    box.appendChild(amount); box.appendChild(quick);
    var go = el('button', 'bet-btn'); go.type = 'button';
    main.appendChild(box); main.appendChild(go);
    root.appendChild(top); root.appendChild(main);

    inAmt.value = fmt(load('rk.amt', 0.01));
    inAuto.value = fmt(load('rk.autoval', 2));
    cbAuto.checked = !!load('rk.auto', false);

    function readAmt() { var v = parseFloat(inAmt.value); return isFinite(v) ? v : 0; }
    function setAmt(v) {
      v = Math.min(1000, Math.max(0.01, Math.round(v * 100) / 100));
      inAmt.value = fmt(v); save('rk.amt', v); lastKey = ''; render();
    }
    function readAuto() {
      if (!cbAuto.checked) return null;
      var v = parseFloat(inAuto.value);
      return isFinite(v) ? Math.round(v * 100) / 100 : null;
    }
    bMinus.addEventListener('click', function () { setAmt(readAmt() - 0.01); });
    bPlus.addEventListener('click', function () { setAmt(readAmt() + 0.01); });
    inAmt.addEventListener('change', function () { setAmt(readAmt() || 0.01); });
    inAuto.addEventListener('change', function () { var v = Math.max(1.01, parseFloat(inAuto.value) || 2); inAuto.value = fmt(v); save('rk.autoval', v); });
    cbAuto.addEventListener('change', function () { save('rk.auto', cbAuto.checked); });

    go.addEventListener('click', function () {
      var v = view();
      if (v.phase === 'flying') cashOut(); else launch(readAmt(), readAuto(), cbAuto.checked);
    });

    var lastKey = '';
    function setBtn(cls, title, small, disabled) {
      go.className = 'bet-btn' + (cls ? ' ' + cls : '');
      go.textContent = '';
      go.appendChild(document.createTextNode(title));
      if (small) go.appendChild(el('small', '', small));
      go.disabled = !!disabled;
    }
    function render() {
      var v = view();
      var flying = v.phase === 'flying';
      var live = flying && game && !game.demo ? fmt(floor2(game.amount * v.mult)) : '';
      var key = [v.phase, live, busy ? 1 : 0, Ava.user ? 1 : 0, readAmt(), game && game.demo ? 'd' : ''].join('|');
      if (key === lastKey) return;
      lastKey = key;

      [inAmt, bMinus, bPlus, cbAuto, inAuto].forEach(function (n) { n.disabled = flying; });
      quick.querySelectorAll('button').forEach(function (b) { b.disabled = flying; });

      if (flying) {
        setBtn('cash', 'Забрать', game.demo ? 'демо без ставки' : live + UNIT, busy);
      } else if (Ava.user) {
        setBtn('', 'Запуск', 'ставка ' + fmt(readAmt()) + UNIT, busy);
      } else {
        setBtn('', 'Демо-запуск', 'без ставки, баллы не тратятся', busy);
      }
    }
    return { root: root, render: render, force: function () { lastKey = ''; render(); }, readAuto: readAuto };
  })();
  betsEl.appendChild(panel.root);

  // ======================= игра =======================
  function mk(g) {
    return { id: g.id, status: g.status, amount: Number(g.amount), auto: g.auto === null || g.auto === undefined ? null : Number(g.auto),
             mult: g.mult, payout: g.payout, crash_point: g.crash_point, start: g.start_at, demo: false };
  }

  function view() {
    if (!game) return { phase: 'idle', mult: 1, secs: 0 };
    if (game.status === 'active') {
      var t = game.demo ? Date.now() : serverNow();
      var secs = Math.max(0, (t - game.start) / 1000);
      return { phase: 'flying', secs: secs, mult: Math.exp(growth * secs) };
    }
    if (game.status === 'lost') {
      var cp = Number(game.crash_point);
      return { phase: 'crashed', mult: cp, secs: Math.log(Math.max(1, cp)) / growth };
    }
    var m = Number(game.mult);
    return { phase: 'cashed', mult: m, secs: Math.log(Math.max(1, m)) / growth };
  }

  function launch(amt, auto, autoOn) {
    if (busy) return;
    setMsg('');
    if (autoOn && (auto === null || auto < 1.01)) { setMsg(Ava.errText({ message: 'BAD_AUTO' })); return; }
    if (!Ava.user) { startDemo(auto); return; }
    busy = true; panel.force();
    Ava.call('rocket_launch', { p_amount: amt, p_auto: auto }).then(function (s) {
      onState(s, Date.now(), Date.now(), true);
    }, function (e) {
      setMsg(Ava.errText(e));
      if (e.message === 'ALREADY_FLYING') pollOnce();
    }).then(function () { busy = false; panel.force(); });
  }

  function cashOut() {
    if (busy || !game || game.status !== 'active') return;
    if (game.demo) {
      var v = view();
      game.status = 'won'; game.mult = Math.max(1, floor2(v.mult));
      finishFx(); panel.force();
      return;
    }
    busy = true; panel.force(); setMsg('');
    Ava.call('rocket_cashout').then(function (s) {
      onState(s, Date.now(), Date.now(), true);
    }, function (e) { setMsg(Ava.errText(e)); }).then(function () { busy = false; panel.force(); });
  }

  function startDemo(auto) {
    var cp = Math.min(200, Math.max(1, Math.floor(97 / (1 - Math.random())) / 100));
    resetFx();
    pokedAuto = false;
    game = { id: 'demo' + Date.now(), demo: true, status: 'active', start: Date.now(), crash_point: cp, amount: 0, auto: auto, mult: null, payout: 0 };
    panel.force();
  }

  // ----- ответы сервера -----
  function onState(s, t0, t1, isAction) {
    offset = s.server_now - (t0 + t1) / 2;
    growth = Number(s.growth) || growth;
    if (Ava.user && s.balance !== null && s.balance !== undefined) Ava.setBalance(s.balance);
    renderHistory(s.history || []);
    var g = s.game;
    if (g) {
      if (g.status === 'active') {
        if (!game || game.id !== g.id) { resetFx(); pokedAuto = false; }
        game = mk(g);
        ensurePoll();
      } else if (game && game.id === g.id) {
        var was = game.status;
        game = mk(g);
        if (was === 'active') finishFx();
      } else if (isAction) {                 // игра закончилась сразу (например, x1.00)
        resetFx(); game = mk(g); finishFx();
      }                                      // иначе это старая игра до открытия страницы: не показываем
    }
    if (!Ava.user) setMsg('Войдите в аккаунт, чтобы играть на баллы. Демо-запуск доступен всем.', true);
    else if (s.balance !== null && Number(s.balance) < 0.01 && (!game || game.status !== 'active')) setMsg('Баланс пуст. Покрутите рулетку выше, чтобы получить баллы.', true);
    else if (msgEl.style.color) setMsg('');
    panel.force();
  }

  function renderHistory(h) {
    var key = h.join(',');
    if (key === lastHist) return;
    lastHist = key;
    histEl.textContent = '';
    h.forEach(function (x, i) {
      x = Number(x);
      histEl.appendChild(el('span', 'rk-chip' + (x < 2 ? ' lo' : (x >= 10 ? ' hi' : '')) + (i === 0 ? ' first' : ''), fmt(x) + 'x'));
    });
  }

  function pollOnce() {
    var t0 = Date.now();
    return Ava.rpc('rocket_state', { p_token: Ava.token || null }).then(function (s) { onState(s, t0, Date.now(), false); }, function () {});
  }
  function ensurePoll() {            // пока самолёт в воздухе, спрашиваем сервер, не упал ли он
    if (polling) return;
    polling = true;
    (function loop() {
      pollOnce().then(function () {
        if (game && !game.demo && game.status === 'active') pollTimer = setTimeout(loop, 300);
        else polling = false;
      });
    })();
  }

  // ======================= рисование =======================
  var W = 0, H = 0, dpr = 1;
  var stars = [], clouds = [];
  var sparks = [], smoke = [];
  var fall = null, away = null;
  var lastT = performance.now();
  var PAD = { l: 50, r: 70, t: 70, b: 50 };

  function resetFx() { sparks = []; smoke = []; fall = null; away = null; }

  function resize() {
    var r = stage.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(200, r.width); H = Math.max(160, r.height);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    stars = [];
    for (var i = 0; i < 70; i++) stars.push({ x: Math.random() * W, y: Math.random() * H * 0.8, r: Math.random() * 1.4 + 0.3, ph: Math.random() * 6.28 });
    clouds = [];
    for (var j = 0; j < 9; j++) clouds.push({ x: Math.random() * W, y: H - 30 - Math.random() * 70, w: 90 + Math.random() * 120, a: 0.10 + Math.random() * 0.12, sp: 6 + Math.random() * 10 });
  }
  window.addEventListener('resize', resize);
  resize();

  function planeWidth() { return PLANE.width * Math.min(1, W / 700 + 0.35); }

  // ----- траектория: растущая кривая + покачивание вверх-вниз -----
  function seedOf() { var id = game ? String(game.id) : '0'; var n = 0; for (var i = 0; i < id.length; i++) n = (n * 31 + id.charCodeAt(i)) % 628; return n / 100; }
  function wob(t, seed) {
    if (!WOBBLE.amp) return 0;
    var ramp = 1 - Math.exp(-t / 2.5);
    return H * WOBBLE.amp * ramp * (0.6 * Math.sin(WOBBLE.f1 * t + seed) + 0.4 * Math.sin(WOBBLE.f2 * t + seed * 1.7));
  }
  function mapper(secs, mult) {
    var tView = Math.max(8, secs / 0.85), mView = Math.max(2.4, 1 + (mult - 1) / 0.8);
    return {
      X: function (t) { return PAD.l + (t / tView) * (W - PAD.l - PAD.r); },
      Y: function (t) { var m = Math.exp(growth * t); return H - PAD.b - ((m - 1) / (mView - 1)) * (H - PAD.t - PAD.b); }
    };
  }
  function tipOf(v, seed) {
    if (v.phase === 'idle') return { x: PAD.l + 50, y: H - PAD.b - 8, ang: -0.12 };
    var mp = mapper(v.secs, v.mult);
    function pos(t) { return { x: mp.X(t), y: mp.Y(t) - wob(t, seed) }; }
    var a = pos(v.secs), b = pos(Math.max(0, v.secs - 0.2));
    var ang = Math.atan2(a.y - b.y, a.x - b.x);
    if (v.secs < 0.2) ang = -0.25;
    ang = Math.max(-0.9, Math.min(0.9, ang));
    return { x: a.x, y: a.y, ang: ang };
  }

  // ----- самолёт -----
  function vectorPlane(w) {         // запасной вариант, если PNG не загрузился
    var h = w * 0.3;
    ctx.fillStyle = '#f5f0ff'; ctx.strokeStyle = '#2a0a4d'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, 6.283); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#a855f7';
    ctx.beginPath(); ctx.moveTo(-w * 0.05, 0); ctx.lineTo(-w * 0.25, h * 1.5); ctx.lineTo(w * 0.1, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-w * 0.45, 0); ctx.lineTo(-w * 0.5, -h * 1.1); ctx.lineTo(-w * 0.3, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  function drawPlane(x, y, ang, alpha) {
    var w = planeWidth();
    ctx.save();
    ctx.translate(x, y); ctx.rotate(ang + PLANE.angleOffset);
    ctx.globalAlpha = alpha === undefined ? 1 : alpha;
    if (planeImg.complete && planeImg.naturalWidth) {
      var h = w * planeImg.naturalHeight / planeImg.naturalWidth;
      ctx.drawImage(planeImg, -w / 2, -h / 2, w, h);
    } else vectorPlane(w);
    ctx.restore();
  }

  function puff(x, y, ang, dark) {
    var w = planeWidth();
    var tx = x - Math.cos(ang) * w * 0.48, ty = y - Math.sin(ang) * w * 0.48;
    smoke.push({ x: tx, y: ty, vx: -Math.cos(ang) * 25 + (Math.random() - 0.5) * 14, vy: -Math.sin(ang) * 25 + (Math.random() - 0.5) * 14 - 6,
                 r: 3 + Math.random() * 2, g: 9 + Math.random() * 6, life: 1, c: dark ? '70,60,90' : '255,255,255' });
  }

  function explode(tip) {
    for (var i = 0; i < 70; i++) {
      var a = Math.random() * 6.283, sp = 40 + Math.random() * 260;
      sparks.push({ x: tip.x, y: tip.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, c: ['#fbbf24', '#fb7185', '#a855f7', '#fff'][i % 4] });
    }
  }

  // конец игры: падение (проигрыш) или улёт за экран (забрали выигрыш)
  function finishFx() {
    var v = view(), tip = tipOf(v, seedOf());
    if (game.status === 'lost') {
      explode(tip);
      fall = { x: tip.x, y: tip.y, vx: Math.cos(tip.ang) * 150, vy: Math.sin(tip.ang) * 150, ang: tip.ang };
    } else {
      away = { x: tip.x, y: tip.y, ang: tip.ang, speed: 360 };
    }
  }

  function frame(now) {
    var dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
    var t = now / 1000;

    // демо-игра считается здесь же, в браузере
    if (game && game.demo && game.status === 'active') {
      var dv = view();
      if (game.auto && dv.mult >= game.auto) { game.status = 'won'; game.mult = game.auto; finishFx(); panel.force(); }
      else if (dv.mult >= game.crash_point) { game.status = 'lost'; finishFx(); panel.force(); }
    }
    var v = view();
    var seed = seedOf();

    // автовывод достигнут: сразу спросим сервер, чтобы не ждать следующего опроса
    if (game && !game.demo && v.phase === 'flying' && game.auto && v.mult >= game.auto && !pokedAuto) { pokedAuto = true; pollOnce(); }

    // фон
    var bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#1d0c40'); bg.addColorStop(1, '#0b0420');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    stars.forEach(function (s) {
      ctx.globalAlpha = 0.35 + 0.65 * Math.abs(Math.sin(t * 1.5 + s.ph));
      ctx.fillStyle = '#e9d5ff';
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.283); ctx.fill();
    });
    ctx.globalAlpha = 1;

    var speed = v.phase === 'flying' ? 3 : 0.5;
    clouds.forEach(function (c) {
      c.x -= c.sp * speed * dt;
      if (c.x < -c.w) { c.x = W + c.w * 0.3; c.y = H - 30 - Math.random() * 70; }
      ctx.fillStyle = 'rgba(124,58,237,' + c.a + ')';
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, c.w * 0.5, c.w * 0.16, 0, 0, 6.283);
      ctx.ellipse(c.x - c.w * 0.25, c.y + 6, c.w * 0.32, c.w * 0.12, 0, 0, 6.283);
      ctx.ellipse(c.x + c.w * 0.28, c.y + 8, c.w * 0.3, c.w * 0.11, 0, 0, 6.283);
      ctx.fill();
    });
    var fog = ctx.createLinearGradient(0, H - 90, 0, H);
    fog.addColorStop(0, 'rgba(11,4,32,0)'); fog.addColorStop(1, 'rgba(11,4,32,0.85)');
    ctx.fillStyle = fog; ctx.fillRect(0, H - 90, W, 90);

    // пройденный путь самолёта (вместе с подъёмами и спусками)
    var tip = tipOf(v, seed);
    if (v.phase !== 'idle') {
      var mp = mapper(v.secs, v.mult), N = 90;
      var col = v.phase === 'crashed' ? '#fb7185' : (v.phase === 'cashed' ? '#34d399' : '#a78bfa');
      ctx.beginPath();
      for (var i = 0; i <= N; i++) {
        var tt = v.secs * i / N, X = mp.X(tt), Y = mp.Y(tt) - wob(tt, seed);
        if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      }
      ctx.lineWidth = 3.5; ctx.strokeStyle = col; ctx.lineJoin = 'round'; ctx.stroke();
      ctx.lineTo(tip.x, H - PAD.b); ctx.lineTo(mp.X(0), H - PAD.b); ctx.closePath();
      var fill = ctx.createLinearGradient(0, tip.y, 0, H - PAD.b);
      fill.addColorStop(0, v.phase === 'crashed' ? 'rgba(251,113,133,0.25)' : (v.phase === 'cashed' ? 'rgba(52,211,153,0.22)' : 'rgba(124,58,237,0.36)'));
      fill.addColorStop(1, 'rgba(124,58,237,0)');
      ctx.fillStyle = fill; ctx.fill();
    }

    // дым и искры
    if (v.phase === 'flying') { puff(tip.x, tip.y, tip.ang, false); if (Math.random() < 0.5) puff(tip.x, tip.y, tip.ang, false); }
    for (var s = smoke.length - 1; s >= 0; s--) {
      var p = smoke[s];
      p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.g * dt; p.life -= dt * 1.1;
      if (p.life <= 0) { smoke.splice(s, 1); continue; }
      ctx.fillStyle = 'rgba(' + p.c + ',' + (p.life * 0.32) + ')';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
    }
    for (var k = sparks.length - 1; k >= 0; k--) {
      var q = sparks[k];
      q.vy += 260 * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.life -= dt * 0.9;
      if (q.life <= 0) { sparks.splice(k, 1); continue; }
      ctx.globalAlpha = Math.max(0, q.life); ctx.fillStyle = q.c;
      ctx.beginPath(); ctx.arc(q.x, q.y, 2.6, 0, 6.283); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // самолёт
    if (v.phase === 'flying') {
      drawPlane(tip.x, tip.y, tip.ang);
    } else if (v.phase === 'idle') {
      var bob = Math.sin(t * 2.2) * 4;
      drawPlane(tip.x, tip.y + bob, tip.ang + Math.sin(t * 1.6) * 0.03);
    } else if (v.phase === 'crashed' && fall) {
      fall.vy += 620 * dt; fall.x += fall.vx * dt; fall.y += fall.vy * dt;
      fall.ang += (1.35 - fall.ang) * Math.min(1, dt * 2.2);
      puff(fall.x, fall.y, fall.ang, true);
      drawPlane(fall.x, fall.y, fall.ang);
      if (fall.y > H + 80) fall = null;
    } else if (v.phase === 'cashed' && away) {
      away.ang += (-0.22 - away.ang) * Math.min(1, dt * 2);
      away.x += Math.cos(away.ang) * away.speed * dt; away.y += Math.sin(away.ang) * away.speed * dt;
      puff(away.x, away.y, away.ang, false);
      drawPlane(away.x, away.y, away.ang);
      if (away.x > W + 140) away = null;
    }

    // надписи
    if (v.phase === 'idle') {
      multEl.style.opacity = '0';
      multEl.className = 'rk-mult';
      subEl.textContent = 'Нажмите «Запуск», и самолёт взлетит';
    } else {
      multEl.style.opacity = '1';
      multEl.className = 'rk-mult' + (v.phase === 'crashed' ? ' crashed' : (v.phase === 'cashed' ? ' won' : ''));
      multEl.textContent = 'x' + fmt(v.phase === 'flying' ? floor2(v.mult) : v.mult);
      if (v.phase === 'flying') subEl.textContent = game.demo ? 'Демо-полёт' : '';
      else if (v.phase === 'crashed') subEl.textContent = game.demo ? 'Самолёт упал (демо)' : 'Самолёт упал! Ставка проиграна';
      else subEl.textContent = game.demo ? 'Вы забрали x' + fmt(v.mult) + ' (демо)' : 'Забрано +' + fmt(game.payout) + UNIT;
    }

    panel.render();
    requestAnimationFrame(frame);
  }

  // ======================= запуск =======================
  var lastUserId;
  Ava.onChange(function (u) {
    var id = u ? u.id : null;
    panel.force();
    if (id === lastUserId) return;
    lastUserId = id;
    game = null; resetFx(); pokedAuto = false;     // другой пользователь: начинаем с чистого листа
    pollOnce();                                    // история множителей и (если есть) идущая игра
  });
  requestAnimationFrame(frame);
})();
