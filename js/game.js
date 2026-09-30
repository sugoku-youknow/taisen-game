// game.js
// ロビー→待機→対戦→終了、というゲーム全体の流れと、
// ホスト権威型のネットワーク同期(誰か1人が物理演算の「正」を持ち、他人には結果だけ配る)を管理する。
import { getBoardConfig, ZONE_COLORS } from './board.js';
import {
  createWorld,
  buildBoardBodies,
  buildBallDefs,
  spawnBalls,
  launchBall,
  stepWorld,
} from './physics.js';

const STATE_BROADCAST_INTERVAL_MS = 50; // 20Hz
const STEP_MS = 1000 / 60;

export class Game {
  constructor(network) {
    this.network = network;
    this.phase = 'lobby'; // lobby | waiting | countdown | playing | ended
    this.config = null;
    this.zoneAssignment = null; // Map peerId -> zoneIndex
    this.myZone = null;
    this.playerNames = new Map();
    this.ballDefs = null;
    this.winnerZone = null;

    // ホスト側のみ使う実体
    this.engine = null;
    this.bodiesById = null;
    this._loopHandle = null;
    this._lastBroadcast = 0;

    // ゲスト側の描画用(補間して滑らかに見せる)
    this.renderPositions = new Map(); // id -> {x,y} 表示用(平滑化済み)
    this.targetPositions = new Map(); // id -> {x,y} 直近に受信した値

    this.onPhaseChange = () => {};
    this.onCounts = () => {};

    this._wireNetwork();
  }

  _wireNetwork() {
    const net = this.network;
    net.on('start', (payload) => this._handleStart(payload));
    net.on('state', (payload) => this._handleState(payload));
    net.on('end', (payload) => this._handleEnd(payload));
    net.on('input', (payload, { peerId }) => this._handleInput(payload, peerId));
  }

  // ---- ホスト操作: ルーム内の人数からゲームを開始する ----------------
  startAsHost() {
    if (!this.network.isHost) throw new Error('not host');
    const guestIds = Array.from(this.network.peers);
    const playerIds = [this.network.selfId, ...guestIds].slice(0, 4);
    const n = playerIds.length;
    if (n < 2) throw new Error('need at least 2 players');

    const zoneAssignment = new Map();
    playerIds.forEach((id, i) => zoneAssignment.set(id, i));

    const config = getBoardConfig(n);
    const ballDefs = buildBallDefs(config, n);

    const payload = {
      playerCount: n,
      zoneAssignment: playerIds, // index = zoneIndex, value = peerId
      ballDefs,
      playerNames: playerIds.map((id) => ({
        playerId: id,
        playerName: this.network.playerNames.get(id) || id,
      })),
    };
    this.network.send('start', payload);
    this._handleStart(payload); // 自分自身にも同じ手順を適用する
  }

  _handleStart({ playerCount, zoneAssignment, ballDefs, playerNames }) {
    this.config = getBoardConfig(playerCount);
    this.ballDefs = ballDefs;
    this.zoneAssignment = new Map(zoneAssignment.map((peerId, zone) => [peerId, zone]));
    this.myZone = this.zoneAssignment.get(this.network.selfId);
    this.phase = 'countdown';
    this.winnerZone = null;
    this.renderPositions.clear();
    this.targetPositions.clear();
    this.playerNames.clear();

    playerNames.forEach(({ playerId, playerName }) => {
      this.playerNames.set(playerId, playerName);
    });
    ballDefs.forEach((def) => {
      this.renderPositions.set(def.id, { x: def.x, y: def.y });
      this.targetPositions.set(def.id, { x: def.x, y: def.y });
    });

    this.onPhaseChange('countdown');

    setTimeout(() => {
      if (this.phase !== 'countdown') return;

      this.phase = 'playing';

      if (this.network.isHost) {
        this.engine = createWorld();
        buildBoardBodies(this.engine, this.config);
        const bodies = spawnBalls(this.engine, ballDefs);
        this.bodiesById = new Map(bodies.map((b) => [b.gameId, b]));
        this._startHostLoop();
      }

      this.onPhaseChange('playing');
    }, 3000);
  }

  _startHostLoop() {
    let last = performance.now();
    const loop = (now) => {
      if (this.phase !== 'playing') return;
      const dt = Math.min(now - last, 100);
      last = now;
      stepWorld(this.engine, dt);

      const counts = new Array(this.config.playerCount).fill(0);
      const ballStates = [];
      for (const body of this.bodiesById.values()) {
        const zone = this.config.zoneOfPoint(body.position.x, body.position.y);
        counts[zone] += 1;
        ballStates.push({ id: body.gameId, x: body.position.x, y: body.position.y });
        this.targetPositions.set(body.gameId, { x: body.position.x, y: body.position.y });
      }
      this.onCounts(counts);

      const emptyZone = counts.findIndex((c) => c === 0);
      if (emptyZone !== -1) {
        this._declareWinner(emptyZone);
        return;
      }

      if (now - this._lastBroadcast >= STATE_BROADCAST_INTERVAL_MS) {
        this._lastBroadcast = now;
        this.network.send('state', { balls: ballStates, counts });
      }
      this._loopHandle = requestAnimationFrame(loop);
    };
    this._loopHandle = requestAnimationFrame(loop);
  }

  _declareWinner(zoneIndex) {
    this.network.send('end', { winnerZone: zoneIndex });
    this._handleEnd({ winnerZone: zoneIndex });
  }

  _handleEnd({ winnerZone }) {
    this.phase = 'ended';
    this.winnerZone = winnerZone;
    if (this._loopHandle) cancelAnimationFrame(this._loopHandle);
    this.onPhaseChange('ended');
  }

  _handleState({ balls, counts }) {
    if (this.network.isHost) return; // ホストは自分のシミュレーションが正なので無視
    balls.forEach((b) => this.targetPositions.set(b.id, { x: b.x, y: b.y }));
    this.onCounts(counts);
  }

  // ゲストからの発射リクエストをホストが検証して適用する
  _handleInput({ ballId, pull }, peerId) {
    if (!this.network.isHost) return;
    const requesterZone = this.zoneAssignment.get(peerId);
    const body = this.bodiesById.get(ballId);
    if (body == null || requesterZone == null) return;
    const currentZone = this.config.zoneOfPoint(body.position.x, body.position.y);
    if (currentZone !== requesterZone) return; // 自分の陣地にある玉しか打てない
    launchBall(body, pull);
  }

  // ---- 入力(誰でも呼ぶ: ホストなら直接、ゲスト側ならネットワーク送信) ----
  requestLaunch(ballId, pull) {
    if (this.network.isHost) {
      this._handleInput({ ballId, pull }, this.network.selfId);
    } else {
      this.network.send('input', { ballId, pull });
    }
  }

  // 毎フレーム呼び出す: ゲスト側の表示位置をなめらかに追従させる
  smoothRenderPositions() {
    for (const [id, target] of this.targetPositions) {
      const cur = this.renderPositions.get(id) || target;
      this.renderPositions.set(id, {
        x: cur.x + (target.x - cur.x) * 0.35,
        y: cur.y + (target.y - cur.y) * 0.35,
      });
    }
  }

  // 現在自分の陣地にあるボールの一覧(自分のゾーン内にあるボールだけ操作可能にするため)
  // ホスト/ゲストどちらでも同じ「今表示されている位置」を基準に判定する。
  getMyZoneBallIds() {
    if (!this.config) return [];
    return this.getRenderBalls()
      .filter((b) => this.config.zoneOfPoint(b.x, b.y) === this.myZone)
      .map((b) => b.id);
  }

  // 描画用に、現在のボール一覧を {id, x, y, color} の形でまとめて返す。
  // ホストなら物理演算の実体から直接、ゲストなら受信して平滑化した値から。
  getRenderBalls() {
    if (!this.ballDefs) return [];
    if (this.network.isHost && this.bodiesById) {
      return this.ballDefs.map((def) => {
        const body = this.bodiesById.get(def.id);
        return { id: def.id, x: body.position.x, y: body.position.y, color: this.ballColor(def.id) };
      });
    }
    return this.ballDefs.map((def) => {
      const pos = this.renderPositions.get(def.id) || { x: def.x, y: def.y };
      return { id: def.id, x: pos.x, y: pos.y, color: this.ballColor(def.id) };
    });
  }

  ballColor(ballId) {
    const def = this.ballDefs.find((d) => d.id === ballId);
    return ZONE_COLORS[def.zone % ZONE_COLORS.length];
  }
}
