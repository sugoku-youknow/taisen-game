// network.js
// Trystero (https://github.com/dmotz/trystero) を使い、サーバー不要のP2Pルームを作る。
// GitHub Pages のような静的ホスティングだけで、ブラウザ同士が直接つながる。
//
// 設計方針: 「ルームを作った人がホスト」というシンプルな役割分担にする。
// ホストが物理演算(Matter.js)を1つだけ実行して信頼できる状態(state)を作り、
// 他の参加者(ゲスト)は自分の入力(input)をホストへ送るだけにする。
// これにより全員が同じ盤面を見られる(いわゆるホスト権威型のネット同期)。

// nostr戦略: BitTorrentトラッカーより到達性が高く、追加設定が不要なため採用。
const TRYSTERO_CDN_URL = 'https://cdn.skypack.dev/trystero/nostr';

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
  }

  get selfId() {
    return selfIdValue;
  }

  async _join(roomCode) {
    await ensureTrystero();
    this.roomCode = roomCode;
    this.room = joinRoomFn({ appId: APP_ID }, `taisen-${roomCode}`);

    this.room.onPeerJoin((peerId) => {
      this.peers.add(peerId);
      this.onPeerJoin(peerId);
    });
    this.room.onPeerLeave((peerId) => {
      this.peers.delete(peerId);
      this.onPeerLeave(peerId);
    });

    // 使うアクション種別をまとめて登録しておく
    const defineAction = (name) => {
      const [send, get] = this.room.makeAction(name);
      this.actions[name] = { send, get };
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
    const action = this.actions[actionName];
    if (!action) throw new Error(`unknown action: ${actionName}`);
    action.get(callback);
  }

  leave() {
    if (this.room) this.room.leave();
    this.room = null;
  }
}
