/*
 * BLE パネル（汎用の枠）
 *  - NFC タグの URL (?id=XXXX) で起動し、Web Bluetooth で本体 "ATOM-<id>" に接続する
 *  - 画面の定義（UI 定義 JSON）はこのページには含まれていない。
 *    ペアリング済みの接続で本体から読み出し、メモリ上だけで使う（端末には保存しない）
 *  - ?demo=1 で実機なしの動作確認（機密を含まない見本の UI）
 */
'use strict';

const UUID = {
  service: 'a3c80001-5b6e-4d2a-9f41-7e2b1c9d0a01',
  state:   'a3c80002-5b6e-4d2a-9f41-7e2b1c9d0a01',
  command: 'a3c80003-5b6e-4d2a-9f41-7e2b1c9d0a01',
  info:    'a3c80004-5b6e-4d2a-9f41-7e2b1c9d0a01',
  ui:      'a3c80005-5b6e-4d2a-9f41-7e2b1c9d0a01',
};
const SUPPORTED_SCHEMA = 1;  // この枠が読める UI 定義の形式

const params = new URLSearchParams(location.search);
const deviceId = (params.get('id') || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
const demo = params.has('demo');
const bleName = deviceId ? `ATOM-${deviceId}` : null;

const enc = new TextEncoder();
const dec = new TextDecoder();
const $ = (id) => document.getElementById(id);

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

// 32bit FNV-1a（本体側と同じ計算）。UI 定義を正しく読めたかの確認用
function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/* ---------------- 通信: Web Bluetooth ---------------- */
class BleTransport {
  constructor() {
    this.device = null;
    this.q = Promise.resolve();      // GATT 操作は同時に1つだけ
    this.onState = () => {};
    this.onDisconnect = () => {};
  }

  // GATT 操作を直列化（Chrome は並行操作で "GATT operation already in progress" になる）
  op(fn) {
    const p = this.q.then(fn);
    this.q = p.catch(() => {});
    return p;
  }

  async request() {
    const filter = bleName ? { name: bleName, services: [UUID.service] }
                           : { namePrefix: 'ATOM-', services: [UUID.service] };
    this.device = await navigator.bluetooth.requestDevice({ filters: [filter] });
    return this.connect();
  }

  // 以前に許可したデバイスへ自動再接続（Chrome の getDevices 対応時のみ）
  async tryRemembered() {
    if (!navigator.bluetooth.getDevices) return null;
    const list = await navigator.bluetooth.getDevices();
    const dev = list.find((d) => (bleName ? d.name === bleName : d.name?.startsWith('ATOM-')));
    if (!dev) return null;
    this.device = dev;
    try {
      if (dev.watchAdvertisements) {
        const seen = new Promise((res) => dev.addEventListener('advertisementreceived', res, { once: true }));
        await dev.watchAdvertisements();
        await withTimeout(seen, 4000).catch(() => {});
      }
      return await withTimeout(this.connect(), 15000);
    } catch (e) {
      console.warn('remembered connect failed', e);
      return null;
    }
  }

  async connect() {
    this.device.ongattserverdisconnected = () => this.onDisconnect();
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(UUID.service);
    this.cState = await svc.getCharacteristic(UUID.state);
    this.cCmd = await svc.getCharacteristic(UUID.command);
    this.cUi = await svc.getCharacteristic(UUID.ui);
    const cInfo = await svc.getCharacteristic(UUID.info);

    // 最初の読み出しで、未ペアリングならスマホにパスキー入力画面が出る
    const info = JSON.parse(dec.decode(await this.op(() => cInfo.readValue())));
    const ui = await this.readUi(info.ui);

    // readValue() の結果もこのイベントで届く
    this.cState.oncharacteristicvaluechanged = (e) => this.handleValue(e.target.value);
    await this.op(() => this.cState.startNotifications());
    await this.op(() => this.cState.readValue());
    return { info, ui };
  }

  // 分割番号を書き込み → 読み出し、を繰り返して UI 定義を組み立てる
  async readUi(meta) {
    if (!meta?.len || !meta?.chunk) throw new Error('本体が UI 定義を持っていません');
    const buf = new Uint8Array(meta.len);
    let off = 0;
    for (let i = 0; off < meta.len; i++) {
      const dv = await this.op(async () => {
        await this.cUi.writeValueWithResponse(new Uint8Array([i & 0xff, i >> 8]));
        return this.cUi.readValue();
      });
      if (dv.byteLength === 0) break;
      buf.set(new Uint8Array(dv.buffer, dv.byteOffset, Math.min(dv.byteLength, meta.len - off)), off);
      off += dv.byteLength;
    }
    if (off !== meta.len || (meta.hash && fnv1a(buf) !== meta.hash)) {
      throw new Error('UI 定義を正しく読み出せませんでした');
    }
    return JSON.parse(dec.decode(buf));
  }

  handleValue(dv) {
    try {
      this.onState(JSON.parse(dec.decode(dv)));
    } catch {
      // MTU が小さく通知が途中で切れた場合は、全体を読み直す
      this.op(() => this.cState.readValue()).catch(() => {});
    }
  }

  send(obj) {
    return this.op(() => this.cCmd.writeValueWithResponse(enc.encode(JSON.stringify(obj))));
  }

  disconnect() {
    this.device?.gatt?.disconnect();
  }
}

/* ---------------- 通信: デモ（実機なし・見本の UI） ---------------- */
const SAMPLE_UI = {
  schema: 1,
  title: 'サンプル機器',
  hero: {
    value: { key: 'lv', decimals: 0, unit: '%', label: '出力' },
    sub: { key: 'ms', decimals: 1, unit: '', label: '計測値' },
    dimWhen: { pw: [false] },
  },
  status: [
    { key: 'pw', label: '状態', map: { true: '動作中', false: '停止中' } },
    { key: 'md', label: 'モード', map: { a: 'A', b: 'B', c: 'C' } },
    { key: 'ms', label: '計測値', decimals: 1 },
  ],
  infoStatus: [{ key: 'fw', label: 'ファームウェア' }],
  controls: [
    { key: 'pw', type: 'power', label: '電源', onLabel: '動作中', offLabel: '停止中' },
    { key: 'lv', type: 'stepper', label: '出力', min: 0, max: 100, step: 10, decimals: 0, unit: '%', debounceMs: 500, visibleWhen: { md: ['a', 'b'] } },
    { key: 'md', type: 'segmented', label: 'モード', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }] },
  ],
  actions: [{ label: '本体を光らせる', command: { cmd: 'identify' } }],
};

class DemoTransport {
  constructor() {
    this.onState = () => {};
    this.onDisconnect = () => {};
    this.s = { pw: false, md: 'a', lv: 50, ms: 20.0 };
  }
  async request() {
    await new Promise((r) => setTimeout(r, 600));
    setTimeout(() => this.onState({ ...this.s }), 50);
    this.timer = setInterval(() => {
      const target = this.s.pw ? this.s.lv / 2 : 20;
      this.s.ms = Math.round((this.s.ms + (target - this.s.ms) * 0.2) * 10) / 10;
      this.onState({ ...this.s });
    }, 3000);
    toast('デモ: 本体LEDが3回ブリンク');
    return { info: { id: deviceId || 'DEMO', fw: 'demo' }, ui: SAMPLE_UI };
  }
  async tryRemembered() { return null; }
  async send(obj) {
    await new Promise((r) => setTimeout(r, 120));
    if (obj.cmd === 'identify') { toast('デモ: 本体LEDが点滅'); return; }
    if (!obj.cmd) Object.assign(this.s, obj);
    this.onState({ ...this.s });
  }
  disconnect() { clearInterval(this.timer); this.onDisconnect(); }
}

/* ---------------- UI ---------------- */
let ui = null;               // UI 定義（本体から受け取ったもの。保存しない）
let state = {};              // 本体から受け取った最新状態
let info = null;
const widgets = [];          // { update(state) }
const transport = demo ? new DemoTransport() : new BleTransport();

function matches(cond, s) {
  if (!cond) return true;
  return Object.entries(cond).every(([k, vals]) => vals.includes(s[k]));
}

function fmt(v, def) {
  if (v === undefined || v === null) return '--';
  if (def.map) return def.map[String(v)] ?? String(v);
  if (typeof v === 'number' && def.decimals !== undefined) v = v.toFixed(def.decimals);
  return `${v}${def.unit ? ' ' + def.unit : ''}`;
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

async function send(patch) {
  // 楽観的に画面へ反映し、本体からの通知で確定させる
  Object.assign(state, patch);
  render();
  try {
    await transport.send(patch);
  } catch (e) {
    console.error(e);
    toast('送信できませんでした');
  }
}

const POWER_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 3v9"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/></svg>';

const builders = {
  power(def) {
    const el = document.createElement('div');
    el.className = 'card power';
    el.innerHTML = `<div><div class="lbl"></div><div class="state"></div></div>
      <button type="button" aria-pressed="false">${POWER_ICON}</button>`;
    el.querySelector('.lbl').textContent = def.label;
    const btn = el.querySelector('button');
    btn.setAttribute('aria-label', def.label);
    btn.onclick = () => send({ [def.key]: !state[def.key] });
    return {
      el,
      update(s) {
        const on = !!s[def.key];
        btn.setAttribute('aria-pressed', String(on));
        el.querySelector('.state').textContent = on ? def.onLabel : def.offLabel;
      },
    };
  },

  stepper(def) {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `<h2></h2><div class="stepper">
      <button type="button" data-d="-1" aria-label="下げる">−</button>
      <span class="val">--</span>
      <button type="button" data-d="1" aria-label="上げる">＋</button></div>`;
    el.querySelector('h2').textContent = def.label;
    const val = el.querySelector('.val');
    const [down, up] = el.querySelectorAll('button');
    let pending = null, timer = null;
    const clamp = (v) => Math.min(def.max, Math.max(def.min, v));
    const show = (v) => { val.textContent = fmt(v, def); down.disabled = v <= def.min; up.disabled = v >= def.max; };
    const bump = (dir) => {
      const base = pending ?? state[def.key] ?? def.min;
      pending = clamp(Math.round((base + dir * def.step) / def.step) * def.step);
      show(pending);
      // 連打をまとめて1回だけ送信
      clearTimeout(timer);
      timer = setTimeout(() => { const v = pending; pending = null; send({ [def.key]: v }); }, def.debounceMs ?? 500);
    };
    down.onclick = () => bump(-1);
    up.onclick = () => bump(1);
    return { el, update(s) { if (pending === null) show(s[def.key]); } };
  },

  segmented(def) {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = '<h2></h2><div class="seg" role="group"></div>';
    el.querySelector('h2').textContent = def.label;
    const seg = el.querySelector('.seg');
    seg.setAttribute('aria-label', def.label);
    const btns = def.options.map((o) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = o.label;
      b.onclick = () => send({ [def.key]: o.value });
      seg.appendChild(b);
      return [o.value, b];
    });
    return { el, update(s) { btns.forEach(([v, b]) => b.setAttribute('aria-pressed', String(s[def.key] === v))); } };
  },
};

function build() {
  $('title').textContent = ui.title;
  document.title = ui.title;
  document.body.dataset.ui = 'ready';

  const box = $('controls');
  box.innerHTML = '';
  widgets.length = 0;
  for (const def of ui.controls) {
    const make = builders[def.type];
    if (!make) { console.warn('unknown control', def.type); continue; }
    const w = make(def);
    w.def = def;
    box.appendChild(w.el);
    widgets.push(w);
  }

  const acts = $('actions');
  acts.innerHTML = '';
  for (const a of ui.actions || []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost';
    b.textContent = a.label;
    b.onclick = () => transport.send(a.command).then(() => toast(`${a.label}: 送信しました`)).catch(() => toast('送信できませんでした'));
    acts.appendChild(b);
  }
  render();
}

function render() {
  if (!ui) return;
  const h = ui.hero;
  $('hero').classList.toggle('hidden', !h);
  if (h) {
    $('heroLabel').textContent = h.value.label;
    const v = state[h.value.key];
    $('heroValue').textContent = typeof v === 'number' ? v.toFixed(h.value.decimals) : '--';
    $('heroUnit').textContent = h.value.unit;
    const sv = h.sub ? state[h.sub.key] : undefined;
    $('heroSub').textContent = h.sub ? `${h.sub.label} ${typeof sv === 'number' ? sv.toFixed(h.sub.decimals) : '--'}${h.sub.unit}` : '';
    $('hero').classList.toggle('dim', matches(h.dimWhen, state) && Object.keys(state).length > 0);
  }

  for (const w of widgets) {
    w.el.classList.toggle('hidden', !matches(w.def.visibleWhen, state));
    w.update(state);
  }

  const dl = $('status');
  dl.innerHTML = '';
  const rows = [
    ...(ui.status || []).map((def) => [def.label, fmt(state[def.key], def)]),
    ...(ui.infoStatus || []).filter((d) => info?.[d.key] !== undefined).map((d) => [d.label, String(info[d.key])]),
  ];
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  }
  $('statusCard').classList.toggle('hidden', rows.length === 0);
}

/* ---------------- 接続フロー ---------------- */
const READY_MSG = bleName ? `${bleName} と接続します` : '本体とBluetoothで接続します';

function setConn(mode, msg, isErr = false) {
  document.body.dataset.conn = mode;
  $('badgeText').textContent = { on: '接続中', off: '未接続', busy: '接続しています' }[mode];
  $('connectBtn').disabled = mode === 'busy';
  if (msg !== undefined) {
    $('connectMsg').textContent = msg;
    $('connectMsg').classList.toggle('err', isErr);
  }
}

function onConnected(r) {
  if (r.ui?.schema > SUPPORTED_SCHEMA) {
    transport.disconnect();
    throw new Error('この本体には新しい版のページが必要です。ページを再読み込みしてください');
  }
  info = r.info;
  ui = r.ui;
  build();
  setConn('on');
  toast('接続しました');
}

function errorMessage(e) {
  if (e.name === 'NotFoundError') return '本体が見つかりませんでした。近づけてもう一度お試しください';
  if (e.name === 'SecurityError') return 'HTTPS で開いてください';
  if (e.name === 'NetworkError' || e.name === 'NotSupportedError' || /auth|pair|encrypt|GATT/i.test(e.message)) {
    return 'ペアリングできませんでした。パスキーを確認してください。直らないときは、Android の Bluetooth 設定でこの本体の登録を解除してから再度お試しください';
  }
  return `接続できませんでした (${e.message})`;
}

transport.onState = (s) => { state = { ...state, ...s }; render(); };
transport.onDisconnect = () => {
  setConn('off', '接続が切れました。もう一度タップして再接続します');
};

$('connectBtn').onclick = async () => {
  setConn('busy', '一覧から本体を選び、初回はパスキーを入力してください');
  try {
    onConnected(await transport.request());
  } catch (e) {
    console.error(e);
    setConn('off', errorMessage(e), true);
  }
};

async function main() {
  $('foot').textContent = demo ? 'デモモード（実機なし・見本の画面）' : '';
  $('devId').textContent = bleName || 'ATOM-*';

  if (!demo && !navigator.bluetooth) {
    setConn('off', 'このブラウザは Web Bluetooth に対応していません。Android の Chrome で開いてください', true);
    $('connectBtn').disabled = true;
    return;
  }

  setConn('off', READY_MSG);

  // 過去に許可・ペアリング済みなら、タップなしで自動再接続を試す
  if (!demo) {
    setConn('busy', '前回の本体を探しています…');
    const r = await transport.tryRemembered().catch(() => null);
    if (r) {
      try { onConnected(r); } catch (e) { setConn('off', e.message, true); }
    } else {
      setConn('off', READY_MSG);
    }
  }
}

main();
