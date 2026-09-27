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
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字(0/O, 1/I)を除外
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export class Network {
  constructor() {
    this.room = null;
    this.isHost = false;
    this.roomCode = null;
    this.peers = new Set(); // 接続中のゲストpeerId(ホスト視点)
    this.onPeerJoin = () => {};
    this.onPeerLeave = () => {};
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
    this.room = joinRoomFn({ appId: APP_ID }, `taisen-${roomCode}`);

    // 現在のTrysteroはイベントハンドラを「プロパティへの代入」で登録する形式
    // (room.onPeerJoin(fn) ではなく room.onPeerJoin = fn)。
    this.room.onPeerJoin = (peerId) => {
      this.peers.add(peerId);
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
        action.get(this._pendingListeners[name]);
        delete this._pendingListeners[name];
      }
    };
    ['start', 'input', 'state', 'end', 'ping'].forEach(defineAction);
  }

  async createRoom() {
    this.isHost = true;
    const code = generateRoomCode();
    await this._join(code);
    return code;
  }

  async joinRoom(roomCode) {
    this.isHost = false;
    await this._join(roomCode.toUpperCase());
  }

  send(actionName, data, targetPeerId) {
    const action = this.actions[actionName];
    if (!action) throw new Error(`unknown action: ${actionName}`);
    action.send(data, targetPeerId);
  }

  on(actionName, callback) {
    // 部屋を作る/参加する前に呼ばれることがあるので、まず控えておく。
    this._pendingListeners[actionName] = callback;
    const action = this.actions[actionName];
    if (action) action.get(callback);
  }

  leave() {
    if (this.room) this.room.leave();
    this.room = null;
  }
}
