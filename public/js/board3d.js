// 3Dボード描画（Three.js）
// 8×8×8 の立体マス目・球の石・合法手ヒント・視点操作を担当する。

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SIZE, idx, EMPTY, BLACK, WHITE, COLOR_HEX, xOf, yOf, zOf } from '/lib/game.js';

const HALF = (SIZE - 1) / 2;
const HINT_COLOR = { [BLACK]: 0x35d6ff, [WHITE]: 0xffc94d };

/** グリッド座標 → ワールド座標（グリッドY軸が上方向） */
function cellToWorld(x, y, z, target = new THREE.Vector3()) {
  return target.set(x - HALF, y - HALF, z - HALF);
}

const easeOutCubic = (k) => 1 - Math.pow(1 - k, 3);
const easeOutBack = (k) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
};

export class Board3D {
  /**
   * @param {HTMLElement} container
   * @param {{onCellClick?: (cell:{x:number,y:number,z:number,idx:number}) => void}} opts
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.onCellClick = opts.onCellClick || null;

    this.pieceMeshes = new Map(); // idx -> Mesh
    this.hints = new Map(); // idx -> {mesh, x, y, z}
    this.tweens = [];
    this.currentBoard = null;
    this.hoveredIdx = -1;
    this.interactive = false;
    this.turnPlayer = BLACK;
    this.pointerDown = null;
    this.lastMoveIdx = -1;
    this.time = 0;
    this.disposed = false;

    this._initRenderer();
    this._initScene();
    this._initControls();
    this._initEvents();
    this._animate();
  }

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.container.appendChild(this.renderer.domElement);
    this._resize();
  }

  _initScene() {
    const scene = (this.scene = new THREE.Scene());
    scene.background = new THREE.Color(0x05070d);
    scene.fog = new THREE.Fog(0x05070d, 34, 90);

    const camera = (this.camera = new THREE.PerspectiveCamera(46, 1, 0.1, 200));
    camera.position.set(10.5, 8.5, 12.5);

    // ---- ライト ----
    scene.add(new THREE.HemisphereLight(0x8fb6ff, 0x11131c, 0.85));

    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(9, 16, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -9;
    key.shadow.camera.right = 9;
    key.shadow.camera.top = 9;
    key.shadow.camera.bottom = -9;
    key.shadow.camera.near = 2;
    key.shadow.camera.far = 50;
    key.shadow.bias = -0.0006;
    scene.add(key);

    const fill = new THREE.DirectionalLight(0x5a8fff, 0.5);
    fill.position.set(-10, 6, -8);
    scene.add(fill);

    const rim = new THREE.PointLight(0x7c5cff, 30, 40);
    rim.position.set(-6, -4, -6);
    scene.add(rim);

    // ---- 星空 ----
    {
      const n = 1400;
      const positions = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const r = 55 + Math.random() * 60;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        positions[i * 3 + 2] = r * Math.cos(phi);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.PointsMaterial({
        color: 0xbfd4ff,
        size: 0.5,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.75,
        fog: false,
      });
      scene.add(new THREE.Points(geo, mat));
    }

    const boardGroup = (this.boardGroup = new THREE.Group());
    scene.add(boardGroup);

    // ---- グリッド線 ----
    {
      const positions = [];
      const S = SIZE / 2;
      const addLine = (a, b) => positions.push(...a, ...b);
      // X方向の線
      for (let y = 0; y <= SIZE; y++) {
        for (let z = 0; z <= SIZE; z++) addLine([-S, y - S, z - S], [S, y - S, z - S]);
      }
      // Y方向の線
      for (let x = 0; x <= SIZE; x++) {
        for (let z = 0; z <= SIZE; z++) addLine([x - S, -S, z - S], [x - S, S, z - S]);
      }
      // Z方向の線
      for (let x = 0; x <= SIZE; x++) {
        for (let y = 0; y <= SIZE; y++) addLine([x - S, y - S, -S], [x - S, y - S, S]);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const mat = new THREE.LineBasicMaterial({
        color: 0x33507a,
        transparent: true,
        opacity: 0.38,
      });
      boardGroup.add(new THREE.LineSegments(geo, mat));
    }

    // ---- 外枠（明るいエッジ） ----
    {
      const S = SIZE / 2;
      const corners = [
        [-S, -S, -S],
        [S, -S, -S],
        [S, -S, S],
        [-S, -S, S],
      ];
      const positions = [];
      // 上下の4辺
      for (let level = -S; level <= S; level += SIZE) {
        for (let i = 0; i < 4; i++) {
          const a = corners[i];
          const b = corners[(i + 1) % 4];
          positions.push(a[0], level, a[2], b[0], level, b[2]);
        }
      }
      // 縦の4辺
      for (const c of corners) positions.push(c[0], -S, c[2], c[0], S, c[2]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const mat = new THREE.LineBasicMaterial({ color: 0x6fb7ff, transparent: true, opacity: 0.85 });
      boardGroup.add(new THREE.LineSegments(geo, mat));
    }

    // ---- ガラス風の外箱 ----
    {
      const geo = new THREE.BoxGeometry(SIZE + 0.04, SIZE + 0.04, SIZE + 0.04);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x2a5a8a,
        transparent: true,
        opacity: 0.055,
        side: THREE.BackSide,
        depthWrite: false,
      });
      boardGroup.add(new THREE.Mesh(geo, mat));
    }

    // ---- 影を受け取る床（見えない平面） ----
    {
      const geo = new THREE.PlaneGeometry(40, 40);
      const mat = new THREE.ShadowMaterial({ opacity: 0.4 });
      const floor = new THREE.Mesh(geo, mat);
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -SIZE / 2 - 0.55;
      floor.receiveShadow = true;
      scene.add(floor);
    }

    // ---- 石のマテリアル・ジオメトリ ----
    this.pieceGeo = new THREE.SphereGeometry(0.42, 36, 26);
    this.matBlack = new THREE.MeshPhysicalMaterial({
      color: COLOR_HEX[BLACK],
      roughness: 0.32,
      metalness: 0.15,
      clearcoat: 0.8,
      clearcoatRoughness: 0.25,
    });
    this.matWhite = new THREE.MeshPhysicalMaterial({
      color: COLOR_HEX[WHITE],
      roughness: 0.35,
      metalness: 0.05,
      clearcoat: 0.7,
      clearcoatRoughness: 0.3,
    });

    // ---- ヒント球 ----
    this.hintGeo = new THREE.SphereGeometry(0.14, 16, 12);

    // ---- ホバーゴースト ----
    this.ghost = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 24, 18),
      new THREE.MeshBasicMaterial({ color: 0x35d6ff, transparent: true, opacity: 0.32, depthWrite: false })
    );
    this.ghost.visible = false;
    scene.add(this.ghost);

    // ---- 最終着手マーカー ----
    this.lastMoveRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.56, 0.035, 10, 48),
      new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.95 })
    );
    this.lastMoveRing.rotation.x = Math.PI / 2;
    this.lastMoveRing.visible = false;
    scene.add(this.lastMoveRing);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
  }

  _initControls() {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.85;
    this.controls.minDistance = 6.5;
    this.controls.maxDistance = 34;
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  _initEvents() {
    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);

    const el = this.renderer.domElement;
    this._onPointerDown = (e) => {
      this.pointerDown = { x: e.clientX, y: e.clientY, t: Date.now() };
    };
    this._onPointerUp = (e) => {
      if (!this.pointerDown) return;
      const dx = e.clientX - this.pointerDown.x;
      const dy = e.clientY - this.pointerDown.y;
      this.pointerDown = null;
      if (Math.hypot(dx, dy) > 7) return; // ドラッグ（視点回転）だった場合は無視
      if (!this.interactive) return;
      const hit = this._pickHint(e);
      if (hit && this.onCellClick) this.onCellClick(hit);
    };
    this._onPointerMove = (e) => {
      this._updatePointer(e);
    };
    el.addEventListener('pointerdown', this._onPointerDown);
    el.addEventListener('pointerup', this._onPointerUp);
    el.addEventListener('pointermove', this._onPointerMove);
    el.addEventListener('pointerleave', () => {
      this.hoveredIdx = -1;
      this.ghost.visible = false;
    });
  }

  _resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    if (this.camera) {
      this.camera.aspect = w / Math.max(1, h);
      this.camera.updateProjectionMatrix();
    }
  }

  _updatePointer(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  _pickHint(e) {
    this._updatePointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const meshes = [...this.hints.values()].map((h) => h.mesh);
    if (meshes.length === 0) return null;
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;
    const mesh = hits[0].object;
    for (const h of this.hints.values()) {
      if (h.mesh === mesh) return { x: h.x, y: h.y, z: h.z, idx: h.idx };
    }
    return null;
  }

  // ------------------------------------------------------------------
  // 状態の反映
  // ------------------------------------------------------------------

  /**
   * 盤面を設定する。
   * @param {number[]} flat 512要素の配列 (0/1/2)
   * @param {{reset?: boolean, lastMove?: {idx:number,player:number,flipped:number[]}|null}} opts
   */
  setBoard(flat, opts = {}) {
    const { reset = false, lastMove = null } = opts;
    if (reset || !this.currentBoard) {
      for (const mesh of this.pieceMeshes.values()) this._removeMesh(mesh);
      this.pieceMeshes.clear();
      this.tweens.length = 0;
      this.currentBoard = new Array(flat.length).fill(0);
      this.lastMoveIdx = -1;
    }

    const flipSet = new Set(lastMove?.flipped || []);
    for (let i = 0; i < flat.length; i++) {
      const v = flat[i];
      if (v === this.currentBoard[i]) continue;
      const x = xOf(i);
      const y = yOf(i);
      const z = zOf(i);
      if (v === EMPTY) {
        const mesh = this.pieceMeshes.get(i);
        if (mesh) {
          this._removeMesh(mesh);
          this.pieceMeshes.delete(i);
        }
        continue;
      }
      let mesh = this.pieceMeshes.get(i);
      if (!mesh) {
        mesh = this._createPiece(x, y, z, v);
        this.pieceMeshes.set(i, mesh);
        if (!reset && lastMove && i === lastMove.idx) {
          this._animateDrop(mesh);
        } else {
          mesh.position.copy(cellToWorld(x, y, z));
          mesh.scale.setScalar(1);
        }
      } else {
        if (!reset && flipSet.has(i)) {
          this._animateFlip(mesh, v);
        } else {
          this._tweenKill(mesh);
          mesh.scale.setScalar(1);
          mesh.material = v === BLACK ? this.matBlack : this.matWhite;
        }
      }
    }
    this.currentBoard = flat.slice();

    if (lastMove && !reset) {
      this.setLastMove(lastMove.idx);
    } else if (reset) {
      this.setLastMove(-1);
    }
  }

  setHints(moves, player) {
    const next = new Map();
    for (const m of moves) next.set(m.idx, m);

    // 古いヒントを削除
    for (const [i, h] of this.hints) {
      if (!next.has(i)) {
        this._removeMesh(h.mesh);
        this.hints.delete(i);
      }
    }
    // 新しいヒントを追加
    const color = HINT_COLOR[player] ?? HINT_COLOR[BLACK];
    for (const [i, m] of next) {
      let h = this.hints.get(i);
      if (!h) {
        const mesh = new THREE.Mesh(this.hintGeo, new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.9,
        }));
        mesh.position.copy(cellToWorld(m.x, m.y, m.z));
        mesh.userData.baseScale = 1;
        this.scene.add(mesh);
        h = { mesh, x: m.x, y: m.y, z: m.z, idx: i };
        this.hints.set(i, h);
      } else {
        h.mesh.material.color.setHex(color);
      }
      h.player = player;
    }
    this.turnPlayer = player;
    this.ghost.material.color.setHex(color);
  }

  clearHints() {
    for (const h of this.hints.values()) this._removeMesh(h.mesh);
    this.hints.clear();
    this.ghost.visible = false;
    this.hoveredIdx = -1;
  }

  setLastMove(i) {
    this.lastMoveIdx = i ?? -1;
    if (this.lastMoveIdx == null || this.lastMoveIdx < 0 || !this.pieceMeshes.has(this.lastMoveIdx)) {
      this.lastMoveRing.visible = false;
      return;
    }
    const mesh = this.pieceMeshes.get(this.lastMoveIdx);
    this.lastMoveRing.position.copy(mesh.position);
    this.lastMoveRing.position.y -= 0.16;
    this.lastMoveRing.visible = true;
  }

  setInteractive(v) {
    this.interactive = v;
    if (!v) {
      this.ghost.visible = false;
      this.hoveredIdx = -1;
    }
  }

  // ------------------------------------------------------------------
  // アニメーション
  // ------------------------------------------------------------------

  _createPiece(x, y, z, player) {
    const mesh = new THREE.Mesh(this.pieceGeo, player === BLACK ? this.matBlack : this.matWhite);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.copy(cellToWorld(x, y, z));
    this.scene.add(mesh);
    return mesh;
  }

  _removeMesh(mesh) {
    this.scene.remove(mesh);
  }

  _tweenKill(mesh) {
    this.tweens = this.tweens.filter((t) => t.mesh !== mesh);
  }

  _animateDrop(mesh) {
    this._tweenKill(mesh);
    const baseY = mesh.position.y;
    const t0 = performance.now();
    this.tweens.push({
      mesh,
      update: () => {
        const k = Math.min(1, (performance.now() - t0) / 420);
        const e = easeOutCubic(k);
        mesh.position.y = baseY + (1 - e) * 2.2;
        const s = 0.45 + 0.55 * e;
        mesh.scale.setScalar(s);
        if (k >= 1) {
          mesh.position.y = baseY;
          mesh.scale.setScalar(1);
          return true;
        }
        return false;
      },
    });
  }

  _animateFlip(mesh, player) {
    this._tweenKill(mesh);
    const t0 = performance.now();
    const phase1 = 140;
    const phase2 = 200;
    const mat = player === BLACK ? this.matBlack : this.matWhite;
    this.tweens.push({
      mesh,
      update: () => {
        const el = performance.now() - t0;
        if (el < phase1) {
          const k = el / phase1;
          const sx = Math.max(0.02, 1 - k);
          mesh.scale.set(sx, 1, 1);
        } else {
          if (mesh.material !== mat) mesh.material = mat;
          const k = Math.min(1, (el - phase1) / phase2);
          const s = easeOutBack(Math.max(0.001, k));
          mesh.scale.set(Math.min(1.15, s), Math.min(1.15, s), Math.min(1.15, s));
          if (k >= 1) {
            mesh.scale.setScalar(1);
            return true;
          }
        }
        return false;
      },
    });
  }

  // ------------------------------------------------------------------
  // メインループ
  // ------------------------------------------------------------------

  _animate = () => {
    if (this.disposed) return;
    requestAnimationFrame(this._animate);
    this.time = performance.now() / 1000;

    // ツイーン処理
    if (this.tweens.length > 0) {
      const rest = [];
      for (const t of this.tweens) {
        if (!t.update()) rest.push(t);
      }
      this.tweens = rest;
    }

    // ヒントの脈動
    for (const h of this.hints.values()) {
      const pulse = 1 + 0.3 * Math.sin(this.time * 3.2 + h.idx * 0.7);
      h.mesh.scale.setScalar(pulse);
      h.mesh.material.opacity = 0.65 + 0.3 * Math.sin(this.time * 3.2 + h.idx * 0.7);
    }

    // 最終着手マーカーの脈動
    if (this.lastMoveRing.visible) {
      const p = 1 + 0.12 * Math.sin(this.time * 4);
      this.lastMoveRing.scale.set(p, p, 1);
      this.lastMoveRing.material.opacity = 0.6 + 0.35 * Math.sin(this.time * 4);
    }

    // ホバーゴースト
    if (this.interactive && this.hints.size > 0) {
      const hit = this._pickHintFromLastPointer();
      if (hit) {
        if (this.hoveredIdx !== hit.idx) {
          this.hoveredIdx = hit.idx;
          this.ghost.position.copy(cellToWorld(hit.x, hit.y, hit.z));
        }
        this.ghost.visible = true;
        const p = 1 + 0.1 * Math.sin(this.time * 5);
        this.ghost.scale.setScalar(p);
      } else {
        this.hoveredIdx = -1;
        this.ghost.visible = false;
      }
    } else {
      this.ghost.visible = false;
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  _pickHintFromLastPointer() {
    if (this.hints.size === 0) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const meshes = [...this.hints.values()].map((h) => h.mesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;
    const mesh = hits[0].object;
    for (const h of this.hints.values()) if (h.mesh === mesh) return h;
    return null;
  }

  dispose() {
    this.disposed = true;
    window.removeEventListener('resize', this._onResize);
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this._onPointerDown);
    el.removeEventListener('pointerup', this._onPointerUp);
    el.removeEventListener('pointermove', this._onPointerMove);
    this.controls.dispose();
    this.renderer.dispose();
    if (el.parentElement) el.parentElement.removeChild(el);
  }
}
