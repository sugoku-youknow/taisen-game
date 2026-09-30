// network.js
// Trystero (https://github.com/dmotz/trystero) を使い、サーバー不要のP2Pルームを作る。
// GitHub Pages のような静的ホスティングだけで、ブラウザ同士が直接つながる。
//
// 設計方針: 「ルームを作った人がホスト」というシンプルな役割分担にする。
// ホストが物理演算(Matter.js)を1つだけ実行して信頼できる状態(state)を作り、
// 他の参加者(ゲスト)は自分の入力(input)をホストへ送るだけにする。
// これにより全員が同じ盤面を見られる(いわゆるホスト権威型のネット同期)。

// CDN経由でTrysteroを読み込む。esm.run(jsdelivr)は現在も保守されている配信元で、
// Trystero公式READMEもこの読み込み方法を案内している。
// (以前使っていたSkypackはすでにメンテナンス終了しており、読み込みに失敗していた)
// trystero本体は現在デフォルトでNostr戦略(追加設定不要で到達性が高い分散ネットワーク)を使う。
const TRYSTERO_CDN_URL = 'https://esm.run/trystero';

// 同じアプリを使う全ルームに共通の名前空間。他のTrysteroアプリと部屋名が衝突しないための識別子。
const APP_ID = 'taisen-game-rubberband-v1';

let joinRoomFn = null;
let selfIdValue = null;

async function ensureTrystero() {
  if (joinRoomFn) return;
  const mod = await import(/* webpackIgnore: true */ TRYSTERO_CDN_URL);
  joinRoomFn = mod.joinRoom;
  selfIdValue = mod.selfId;
}

export function generateRoomCode() {
  return String(Math.floor(Math.random() * 10));
}

export class Network {
  constructor() {
    this.room = null;
    this.isHost = false;
    this.roomCode = null;
    this.playerName = '';
    this.playerNames = new Map();
    this.peers = new Set(); // 接続中のゲストpeerId(ホスト視点)
    this.onPeerJoin = () => {};
    this.onPeerLeave = () => {};
    this.onPlayerName = () => {};
    this.actions = {};
    // Game側は「部屋を作る前」に on() を呼んで受信の準備をするため、
    // 部屋(room)がまだ無い時点の登録はここに一旦ためておき、
    // 実際に部屋ができたタイミングで改めて紐づける。
    this._pendingListeners = {};
  }

  get selfId() {
    return selfIdValue;
  }

  async _join(roomCode) {
    await ensureTrystero();
    this.roomCode = roomCode;
    this.room = joinRoomFn(
      {
        appId: APP_ID,
        relayConfig: {
          redundancy: 5
        }
      },
      `taisen-${roomCode}`
    );

    // 現在のTrysteroはイベントハンドラを「プロパティへの代入」で登録する形式
    // (room.onPeerJoin(fn) ではなく room.onPeerJoin = fn)。
    this.room.onPeerJoin = (peerId) => {
      this.peers.add(peerId);
      this.send('name', { name: this.playerName }, peerId);
      this.onPeerJoin(peerId);
    };
    this.room.onPeerLeave = (peerId) => {
      this.peers.delete(peerId);
      this.onPeerLeave(peerId);
    };

    // 使うアクション種別をまとめて登録しておく
    const defineAction = (name) => {
      const action = this.room.makeAction(name);
      this.actions[name] = action;
      // on()が部屋作成より先に呼ばれていた場合は、ここで改めて紐づける
      if (this._pendingListeners[name]) {
        action.onMessage = this._pendingListeners[name];
        delete this._pendingListeners[name];
      }
    };
    ['start', 'input', 'state', 'end', 'ping', 'name'].forEach(defineAction);

    this.actions.name.onMessage = ({ name }, { peerId }) => {
      this.playerNames.set(peerId, name);
      this.onPlayerName(peerId, name);
    };
  }

  async createRoom(playerName) {
    this.isHost = true;
    this.playerName = playerName;

    const code = generateRoomCode();
    await this._join(code);

    this.playerNames.set(this.selfId, playerName);

    return code;
  }

  async joinRoom(roomCode, playerName) {
    this.isHost = false;
    this.playerName = playerName;
    await this._join(roomCode.toUpperCase());

    this.playerNames.set(this.selfId, playerName);
    this.send('name', { name: playerName });
  }

  send(actionName, data, targetPeerId) {
    const action = this.actions[actionName];
    if (!action) throw new Error(`unknown action: ${actionName}`);

    if (targetPeerId) {
      action.send(data, { target: targetPeerId });
    } else {
      action.send(data);
    }
  }

  on(actionName, callback) {
    const action = this.actions[actionName];

    if (action) {
      action.onMessage = callback;
      return;
    }

    // 部屋を作る前なら、あとで登録する
    this._pendingListeners[actionName] = callback;
  }

  leave() {
    if (this.room) this.room.leave();
    this.room = null;
  }
}
