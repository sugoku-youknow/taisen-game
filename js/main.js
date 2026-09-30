import { Network } from './network.js';
import { Game } from './game.js';
import { ZONE_COLORS, BALL_RADIUS_PX } from './board.js';

const network = new Network();
const game = new Game(network);

// ---- 画面切り替え ----------------------------------------------------
const screens = {
  lobby: document.getElementById('screen-lobby'),
  waiting: document.getElementById('screen-waiting'),
  game: document.getElementById('screen-game'),
  ended: document.getElementById('screen-ended'),
};
function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => el.classList.toggle('hidden', key !== name));
}

// ---- ロビー ----------------------------------------------------------
const lobbyError = document.getElementById('lobby-error');
const playerNameInput = document.getElementById('input-player-name');
let playerName = '';
document.getElementById('btn-create-room').addEventListener('click', async () => {
  lobbyError.textContent = '';

  playerName = playerNameInput.value.trim();
  if (!playerName) {
    lobbyError.textContent = 'プレイヤー名を入力してください。';
    return;
  }

  try {
    const code = await network.createRoom(playerName);
    document.getElementById('room-code-display').textContent = code;
    setupWaitingScreenForHost();
    showScreen('waiting');
  } catch (e) {
    console.error(e);
    lobbyError.textContent = '部屋の作成に失敗しました。通信環境を確認してもう一度お試しください。';
  }
});

document.getElementById('btn-join-room').addEventListener('click', async () => {
  lobbyError.textContent = '';
  playerName = playerNameInput.value.trim();
  if (!playerName) {
    lobbyError.textContent = 'プレイヤー名を入力してください。';
    return;
  }
  const code = document.getElementById('input-room-code').value.trim();
  if (code.length !== 1 || !/^[0-9]$/.test(code)) {
    lobbyError.textContent = '部屋コードを入力してください。';
    return;
  }
  try {
    await network.joinRoom(code, playerName);
    document.getElementById('room-code-display').textContent = code.toUpperCase();
    setupWaitingScreenForGuest();
    showScreen('waiting');
  } catch (e) {
    console.error(e);
    lobbyError.textContent = '参加に失敗しました。部屋コードを確認してください。';
  }
});

// ---- 待機画面 ----------------------------------------------------------
function renderPlayerList() {
  const list = document.getElementById('player-list');
  const ids = [network.selfId, ...network.peers];
  document.getElementById('player-count').textContent = ids.length;
  list.innerHTML = '';
  ids.forEach((id, i) => {
    const li = document.createElement('li');
    li.textContent = network.playerNames.get(id) || `プレイヤー ${i + 1}`;

    if (id === network.selfId && network.isHost) {
      li.textContent += ' (ホスト)';
    }
    if (id === network.selfId) li.classList.add('me');
    list.appendChild(li);
  });
  const startBtn = document.getElementById('btn-start-game');
  if (network.isHost) {
    startBtn.disabled = ids.length < 2 || ids.length > 4;
  }
}

function setupWaitingScreenForHost() {
  document.getElementById('host-only-note').classList.remove('hidden');
  document.getElementById('btn-start-game').classList.remove('hidden');
  document.getElementById('guest-wait-note').classList.add('hidden');
  network.onPeerJoin = renderPlayerList;
  network.onPeerLeave = renderPlayerList;
  renderPlayerList();
}

function setupWaitingScreenForGuest() {
  document.getElementById('host-only-note').classList.add('hidden');
  document.getElementById('btn-start-game').classList.add('hidden');
  document.getElementById('guest-wait-note').classList.remove('hidden');
  network.onPeerJoin = renderPlayerList;
  network.onPeerLeave = renderPlayerList;
  renderPlayerList();
}

document.getElementById('btn-start-game').addEventListener('click', () => {
  try {
    game.startAsHost();
  } catch (e) {
    console.error(e);
  }
});

document.getElementById('btn-leave-waiting').addEventListener('click', () => {
  network.leave();
  location.reload();
});
document.getElementById('btn-leave-game').addEventListener('click', () => {
  network.leave();
  location.reload();
});
document.getElementById('btn-back-to-lobby').addEventListener('click', () => {
  location.reload();
});

// ---- ゲーム画面: キャンバス描画 ---------------------------------------
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
let dragState = null; // { ballId, originX, originY, pointerId }

function resizeCanvasForConfig(config) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  canvas.width = config.bounds.width * dpr;
  canvas.height = config.bounds.height * dpr;

  // 縦横比を維持したまま、画面内に最大サイズで表示
  const scale = Math.min(
    window.innerWidth / config.bounds.width,
    window.innerHeight / config.bounds.height
  );

  canvas.style.width = `${config.bounds.width * scale}px`;
  canvas.style.height = `${config.bounds.height * scale}px`;

  // 自分の陣地が画面下に来るように盤面を回転
  let rotation = 0;

  if (config.playerCount === 2) {
    // 2人対戦
    rotation = game.myZone === 0 ? Math.PI : 0;
  } else {
    // 3人・4人対戦
    const wedgeAngle = (Math.PI * 2) / config.playerCount;
    const myZoneCenterAngle =
      wedgeAngle * game.myZone - Math.PI / 2;

    // 自分の陣地の中心を「下方向」に向ける
    rotation = Math.PI / 2 - myZoneCenterAngle;
  }

  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  ctx.setTransform(
    dpr * cos,
    dpr * sin,
    -dpr * sin,
    dpr * cos,
    config.bounds.width / 2 * dpr,
    config.bounds.height / 2 * dpr
  );
}

function drawWallSegment(seg) {
  ctx.save();
  ctx.translate(seg.x, seg.y);
  ctx.rotate(seg.angle);
  ctx.fillStyle = '#4a4438';
  ctx.fillRect(-seg.w / 2, -seg.h / 2, seg.w, seg.h);
  ctx.restore();
}

function drawBoard() {
  const config = game.config;
  ctx.clearRect(-canvas.width, -canvas.height, canvas.width * 2, canvas.height * 2);

  // 台の下地
  ctx.fillStyle = '#efe6cf';
  if (config.kind === 'rect') {
    ctx.fillRect(-config.bounds.width / 2 + 20, -config.bounds.height / 2 + 20, config.bounds.width - 40, config.bounds.height - 40);
  } else {
    ctx.beginPath();
    ctx.arc(0, 0, config.bounds.width / 2 - 20, 0, Math.PI * 2);
    ctx.fill();
  }

  // 陣地の色分け(自分の陣地は少し明るく)
  for (let z = 0; z < config.playerCount; z++) {
    const pts = config.zonePolygon(z);
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = ZONE_COLORS[z % ZONE_COLORS.length];
    ctx.globalAlpha = z === game.myZone ? 0.28 : 0.14;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  config.outerWalls.forEach(drawWallSegment);
  config.dividerWalls.forEach(drawWallSegment);

  // 各陣地の上にプレイヤー名を表示
  ctx.save();
  ctx.fillStyle = '#222';
  ctx.font = 'bold 20px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let z = 0; z < config.playerCount; z++) {
    const playerId = [...game.zoneAssignment.entries()]
      .find(([, zone]) => zone === z)?.[0];

    const name = game.playerNames.get(playerId) || `プレイヤー${z + 1}`;

    const wedgeAngle = (Math.PI * 2) / config.playerCount;
    const centerAngle = wedgeAngle * z - Math.PI / 2;

    const distance = config.bounds.width * 0.32;

    const x = Math.cos(centerAngle) * distance;
    const y = Math.sin(centerAngle) * distance;

    const textAngle = centerAngle;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(textAngle);

    if (Math.cos(textAngle) < 0) {
      ctx.rotate(Math.PI);
    }

    ctx.fillText(name, 0, 0);
    ctx.restore();
  }

  ctx.restore();
}

function drawBalls() {
  const balls = game.getRenderBalls();
  balls.forEach((b) => {
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_RADIUS_PX, 0, Math.PI * 2);
    ctx.fillStyle = b.color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.stroke();
  });
}

function drawDragLine() {
  if (!dragState) return;

  const ball = game.getRenderBalls().find((b) => b.id === dragState.ballId);
  if (!ball) return;

  dragState.originX = ball.x;
  dragState.originY = ball.y;

  // 玉から指までのベクトル
  const dx = dragState.pointerX - ball.x;
  const dy = dragState.pointerY - ball.y;

  const pullLength = Math.hypot(dx, dy);
  if (pullLength < 1) return;

  // 玉が進む方向（指とは反対方向）
  const dirX = -dx / pullLength;
  const dirY = -dy / pullLength;

  // 玉から進行方向へ、引っ張った距離と同じ長さ伸ばす
  const endX = ball.x + dirX * pullLength;
  const endY = ball.y + dirY * pullLength;

  // 指 → 玉 → 進行方向まで黄色い線を描く
  ctx.beginPath();
  ctx.moveTo(dragState.pointerX, dragState.pointerY);
  ctx.lineTo(endX, endY);
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(255,179,71,0.9)';
  ctx.stroke();

  // 進行方向側だけ矢印にする
  const arrowSize = 12;
  const angle = Math.atan2(dirY, dirX);

  ctx.beginPath();
  ctx.moveTo(endX, endY);
  ctx.lineTo(
    endX - arrowSize * Math.cos(angle - Math.PI / 6),
    endY - arrowSize * Math.sin(angle - Math.PI / 6)
  );
  ctx.lineTo(
    endX - arrowSize * Math.cos(angle + Math.PI / 6),
    endY - arrowSize * Math.sin(angle + Math.PI / 6)
  );
  ctx.closePath();

  ctx.fillStyle = 'rgba(255,179,71,0.9)';
  ctx.fill();
}

function updateZoneCounts(counts) {
  const wrap = document.getElementById('zone-counts');
  wrap.innerHTML = '';
  counts.forEach((c, z) => {
    const pill = document.createElement('span');
    pill.className = 'zone-pill' + (z === game.myZone ? ' mine' : '');
    pill.style.background = ZONE_COLORS[z % ZONE_COLORS.length];
    pill.textContent = z === game.myZone ? `自分: ${c}個` : `相手${z + 1}: ${c}個`;
    wrap.appendChild(pill);
  });
}
game.onCounts = updateZoneCounts;

// ---- 入力: 自陣の玉をドラッグして引っ張り、離すと発射 ------------------

function canvasPointToBoard(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const scale = game.config.bounds.width / rect.width;

  // 画面上の座標
  const screenX =
    (clientX - rect.left - rect.width / 2) * scale;

  const screenY =
    (clientY - rect.top - rect.height / 2) * scale;

  // 盤面の回転角を求める
  let rotation = 0;

  if (game.config.playerCount === 2) {
    rotation = game.myZone === 0 ? Math.PI : 0;
  } else {
    const wedgeAngle =
      (Math.PI * 2) / game.config.playerCount;

    const myZoneCenterAngle =
      wedgeAngle * game.myZone - Math.PI / 2;

    rotation = Math.PI / 2 - myZoneCenterAngle;
  }

  // 回転を逆に戻してゲーム内部の座標に変換
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  return {
    x: cos * screenX + sin * screenY,
    y: -sin * screenX + cos * screenY,
  };
}

canvas.addEventListener('pointerdown', (e) => {
  if (game.phase !== 'playing') return;
  const p = canvasPointToBoard(e.clientX, e.clientY);
  const myBalls = game.getRenderBalls().filter((b) => game.getMyZoneBallIds().includes(b.id));
  let closest = null;
  let closestDist = Infinity;
  myBalls.forEach((b) => {
    const d = Math.hypot(b.x - p.x, b.y - p.y);
    if (d < closestDist) {
      closestDist = d;
      closest = b;
    }
  });
  if (closest && closestDist <= BALL_RADIUS_PX * 2.5) {
    dragState = {
      ballId: closest.id,
      originX: closest.x,
      originY: closest.y,
      pointerX: p.x,
      pointerY: p.y,
      pointerId: e.pointerId,
    };
    canvas.setPointerCapture(e.pointerId);
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragState || dragState.pointerId !== e.pointerId) return;
  const p = canvasPointToBoard(e.clientX, e.clientY);
  dragState.pointerX = p.x;
  dragState.pointerY = p.y;
});

function endDrag(e) {
  if (!dragState || dragState.pointerId !== e.pointerId) return;
  const pull = { x: dragState.originX - dragState.pointerX, y: dragState.originY - dragState.pointerY };
  game.requestLaunch(dragState.ballId, pull);
  dragState = null;
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// ---- 描画ループ --------------------------------------------------------
function frame() {
  if (game.phase === 'playing') {
    if (!network.isHost) game.smoothRenderPositions();
    drawBoard();
    drawBalls();
    drawDragLine();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- ゲームの段階変化に応じて画面を切り替える ---------------------------
game.onPhaseChange = (phase) => {
  if (phase === 'countdown') {
    resizeCanvasForConfig(game.config);
    showScreen('game');

    const countdown = document.getElementById('countdown');
    countdown.classList.remove('hidden');

    let count = 3;
    countdown.textContent = count;

    const timer = setInterval(() => {
      count--;

      if (count > 0) {
        countdown.textContent = count;
      } else {
        clearInterval(timer);
        countdown.classList.add('hidden');
      }
    }, 1000);

  } else if (phase === 'playing') {
    resizeCanvasForConfig(game.config);
    showScreen('game');
  } else if (phase === 'ended') {
    const title = document.getElementById('ended-title');
    const msg = document.getElementById('ended-message');
    if (game.winnerZone === game.myZone) {
      title.textContent = '🎉 あなたの勝ち！';
      msg.textContent = '自分の陣地の玉を先に0個にしました。';
    } else {
      title.textContent = '対戦終了';
      msg.textContent = `プレイヤー${game.winnerZone + 1}(陣地${game.winnerZone + 1})の勝ちです。`;
    }
    showScreen('ended');
  }
};
