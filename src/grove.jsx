import React, { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/* ═══════════════════════════════════════════════════════════════════════
   GROVE — a focus timer that grows a 3D garden
   ─────────────────────────────────────────────────────────────────────────
   MODEL LOADING
   Every plant is built behind one factory: createPlantModel(). It calls
   loadModelForTier(), which loads the real GLTF for that model name (from
   assets/models/, cached per name, cloned per plant instance) and falls
   back to a primitive placeholder if that model has no file or fails to
   load. preparePlant() — which normalizes the base to y=0, computes plant
   height, enables shadows, and injects the wind shader per-mesh using
   world-space Y offsets — works on arbitrary nested scene graphs, real or
   placeholder. Tier logic, placement, growth, wilting and persistence are
   all model-agnostic.
   ═══════════════════════════════════════════════════════════════════════ */

/* ───────────────────────────── tiers & models ─────────────────────────── */

const TIERS = {
  sprout: {
    key: "sprout", minutes: 15, label: "15 min", noun: "Clover",
    models: ["Clover_1", "Clover_2", "Grass_Common_Short", "Grass_Wispy_Short", "Mushroom_Common"],
    footprint: 0.9, deadScale: 0.28,
  },
  small: {
    key: "small", minutes: 30, label: "30 min", noun: "Wildflower",
    models: ["Grass_Common_Tall", "Grass_Wispy_Tall", "Fern_1", "Flower_3_Single", "Flower_4_Single", "Plant_1", "Plant_7"],
    footprint: 1.3, deadScale: 0.42,
  },
  medium: {
    key: "medium", minutes: 60, label: "1 hr", noun: "Bush",
    models: ["Flower_3_Group", "Flower_4_Group", "Plant_1_Big", "Plant_7_Big", "Mushroom_Laetiporus", "Bush_Common"],
    footprint: 2.1, deadScale: 0.62,
  },
  large: {
    key: "large", minutes: 120, label: "2 hr", noun: "Pine",
    models: ["Bush_Common_Flowers", "Pine_1", "Pine_2", "Pine_3", "Pine_4", "Pine_5"],
    footprint: 3.2, deadScale: 0.95,
  },
  hero: {
    key: "hero", minutes: 300, label: "5 hr", noun: "Tree",
    models: [
      "CommonTree_1", "CommonTree_2", "CommonTree_3", "CommonTree_4", "CommonTree_5",
      "TwistedTree_1", "TwistedTree_2", "TwistedTree_3", "TwistedTree_4", "TwistedTree_5",
    ],
    footprint: 4.6, deadScale: 1.35,
  },
};
const TIER_ORDER = ["sprout", "small", "medium", "large", "hero"];
const DEAD_MODELS = ["DeadTree_1", "DeadTree_2", "DeadTree_3", "DeadTree_4", "DeadTree_5"];

// name → model file path, used by loadModelForTier() once real loading is wired in
const MODEL_FILES = {};
[...Object.values(TIERS).flatMap((t) => t.models), ...DEAD_MODELS].forEach((n) => {
  MODEL_FILES[n] = `${n}.gltf`;
});

/* ─────────────────────── real model asset resolution ───────────────────────
   Every .gltf, .bin, and texture .png in assets/models is imported as a URL
   up front, keyed by filename. A GLTFLoader with a URL modifier resolves the
   relative "Leaves.png" / "Clover_1.bin" references inside each .gltf JSON
   against this map, so assets load correctly both in dev and in a hashed
   production build.                                                        */
const modelAssetUrls = import.meta.glob("./assets/models/*", {
  eager: true, query: "?url", import: "default",
});
const assetUrlByFile = {};
for (const [path, url] of Object.entries(modelAssetUrls)) {
  assetUrlByFile[path.split("/").pop()] = url;
}

const modelLoadingManager = new THREE.LoadingManager();
modelLoadingManager.setURLModifier((url) => {
  const file = decodeURIComponent(url.split("/").pop().split("?")[0]);
  return assetUrlByFile[file] || url;
});
const gltfLoader = new GLTFLoader(modelLoadingManager);

// modelName → Promise<THREE.Group | null>, one fetch+parse per model, ever
const gltfTemplateCache = new Map();
function loadGLTFTemplate(modelName) {
  if (!gltfTemplateCache.has(modelName)) {
    const fileName = MODEL_FILES[modelName];
    const url = fileName && assetUrlByFile[fileName];
    const promise = url
      ? new Promise((resolve, reject) => {
          gltfLoader.load(url, (gltf) => resolve(gltf.scene), undefined, reject);
        }).catch((err) => {
          console.warn(`[Grove] failed to load model "${modelName}" (${fileName}) — using placeholder`, err);
          return null;
        })
      : Promise.resolve(null);
    gltfTemplateCache.set(modelName, promise);
  }
  return gltfTemplateCache.get(modelName);
}

const GROUND_RADIUS = 26;
const PLANT_LIMIT_RADIUS = 22;

/* ═══════════════ TEMPORARY: test-mode timing — REMOVE WHEN DONE ═══════════
   Compresses every session duration ~100x (15 min → ~9s, 5 hr → ~3 min) so
   timing/growth/wilting can be verified without waiting real hours. Toggle
   with ?test=true in the URL (?test=false turns it back off); the choice
   sticks in localStorage until changed again. All it touches is MS_PER_MIN
   below — delete this block and revert the 4 call sites that use it once
   verification is done. */
const TEST_MODE_KEY = "grove-test-mode-v1";
const TEST_TIME_SCALE = 100;

function resolveTestMode() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has("test")) {
      const on = params.get("test") !== "false";
      window.localStorage.setItem(TEST_MODE_KEY, on ? "1" : "0");
      return on;
    }
    return window.localStorage.getItem(TEST_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

const TEST_MODE = resolveTestMode();
const MS_PER_MIN = TEST_MODE ? (60 * 1000) / TEST_TIME_SCALE : 60 * 1000;

if (TEST_MODE) {
  console.log(
    `%c[Grove] TEST MODE ON — session durations compressed ${TEST_TIME_SCALE}x. ` +
    `Remove ?test=true from the URL or run localStorage.removeItem("${TEST_MODE_KEY}") to disable.`,
    "color: #b45309; font-weight: bold;"
  );
}
/* ═══════════════════════════════════════════════════════════════════════ */

/* ─────────────────────────────── utilities ────────────────────────────── */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const easeInCubic = (t) => t * t * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/* Staged growth: three visible milestones. Within each stage the scale
   eases IN (slow start → dramatic fast finish), landing on the milestone. */
const GROWTH_STAGES = [
  { from: 0,     to: 1 / 3, s0: 0.04, s1: 0.38, name: "Sprouting" },
  { from: 1 / 3, to: 2 / 3, s0: 0.38, s1: 0.72, name: "Growing" },
  { from: 2 / 3, to: 1,     s0: 0.72, s1: 1.0,  name: "Flourishing" },
];
function growthScale(t) {
  t = Math.min(Math.max(t, 0), 1);
  for (const st of GROWTH_STAGES) {
    if (t <= st.to || st.to === 1) {
      const local = (t - st.from) / (st.to - st.from);
      return st.s0 + (st.s1 - st.s0) * easeInCubic(Math.min(Math.max(local, 0), 1));
    }
  }
  return 1;
}
function stageName(t) {
  if (t < 1 / 3) return GROWTH_STAGES[0].name;
  if (t < 2 / 3) return GROWTH_STAGES[1].name;
  return GROWTH_STAGES[2].name;
}
function fmtRemaining(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
function fmtTotal(minutes) {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}
function friendlyName(model) {
  if (model.startsWith("Clover")) return "clover";
  if (model.startsWith("Grass")) return "tuft of grass";
  if (model.startsWith("Mushroom_L")) return "chicken-of-the-woods";
  if (model.startsWith("Mushroom")) return "mushroom";
  if (model.startsWith("Fern")) return "fern";
  if (model.includes("Group")) return "flower patch";
  if (model.startsWith("Flower")) return "wildflower";
  if (model.startsWith("Plant")) return "plant";
  if (model.startsWith("Bush_Common_F")) return "flowering bush";
  if (model.startsWith("Bush")) return "bush";
  if (model.startsWith("Pine")) return "pine";
  if (model.startsWith("TwistedTree")) return "twisted tree";
  if (model.startsWith("CommonTree")) return "tree";
  if (model.startsWith("DeadTree")) return "wilted plant";
  return "plant";
}

/* ─────────────────────────── persistence layer ────────────────────────── */

const K_GARDEN = "grove-garden-v1";
const K_SESSION = "grove-active-session-v1";
const memFallback = {};

async function storeGet(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return memFallback[key] ?? null;
  }
}
async function storeSet(key, obj) {
  memFallback[key] = obj;
  try { window.localStorage.setItem(key, JSON.stringify(obj)); } catch { /* in-memory only */ }
}
async function storeDelete(key) {
  delete memFallback[key];
  try { window.localStorage.removeItem(key); } catch { /* in-memory only */ }
}

/* ──────────────────────── placeholder model library ────────────────────
   Every builder returns a THREE.Group whose base sits at y = 0.
   Sizes deliberately encode the tier hierarchy:
   sprout ≈ 0.35u · small ≈ 0.9u · medium ≈ 1.5u · large ≈ 3u · hero ≈ 5u  */

const PALETTE = {
  leafA: 0x6fae5c, leafB: 0x8cc06b, leafC: 0x4f8f4a, leafD: 0x9dc27a,
  pine: 0x3f7a4d, pineDark: 0x33643e,
  trunk: 0x8a6642, trunkDark: 0x6e4f33, dead: 0x6f5f4e,
  pink: 0xe98fb0, yellow: 0xf2c94c, white: 0xf5efe0, violet: 0xa98fd6,
  mushCap: 0xc96f4a, mushStem: 0xe8dcc8, laet: 0xe8963c,
  stoneA: 0x9a9284, stoneB: 0x867e70, pebble: 0xa9a193,
  petalA: 0xf0b7c9, petalB: 0xf6d7ae,
};
function mat(color, roughness = 0.92) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
}
function put(group, geo, material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, s = 1) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  if (s !== 1) m.scale.setScalar(s);
  group.add(m);
  return m;
}

function buildGrass(rng, height, blades, color, thin = false) {
  const g = new THREE.Group();
  const m = mat(color);
  for (let i = 0; i < blades; i++) {
    const h = height * (0.55 + rng() * 0.45);
    const r = h * (thin ? 0.035 : 0.06);
    const tilt = 0.12 + rng() * 0.35;
    const ang = rng() * Math.PI * 2;
    const cone = put(g, new THREE.ConeGeometry(r, h, 5), m,
      Math.cos(ang) * h * 0.12, h / 2, Math.sin(ang) * h * 0.12,
      Math.cos(ang) * tilt, rng() * Math.PI, Math.sin(ang) * tilt);
    cone.position.y -= h * 0.5 * (1 - Math.cos(tilt)); // keep base grounded
  }
  return g;
}
function buildClover(rng) {
  const g = new THREE.Group();
  const stemM = mat(PALETTE.leafC), leafM = mat(PALETTE.leafB, 0.85);
  const n = 3 + Math.floor(rng() * 2);
  for (let i = 0; i < n; i++) {
    const h = 0.16 + rng() * 0.12;
    const ang = rng() * Math.PI * 2, off = 0.05 + rng() * 0.08;
    const x = Math.cos(ang) * off, z = Math.sin(ang) * off;
    put(g, new THREE.CylinderGeometry(0.012, 0.016, h, 5), stemM, x, h / 2, z);
    const leaf = put(g, new THREE.SphereGeometry(0.07, 8, 6), leafM, x, h + 0.02, z);
    leaf.scale.set(1.25, 0.42, 1.25);
  }
  return g;
}
function buildMushroom(rng) {
  const g = new THREE.Group();
  const h = 0.2 + rng() * 0.08;
  put(g, new THREE.CylinderGeometry(0.045, 0.065, h, 8), mat(PALETTE.mushStem, 0.8), 0, h / 2, 0);
  const cap = put(g, new THREE.SphereGeometry(0.13, 10, 8), mat(PALETTE.mushCap, 0.75), 0, h + 0.015, 0);
  cap.scale.set(1, 0.62, 1);
  if (rng() > 0.5) { // little sibling
    const h2 = h * 0.55;
    put(g, new THREE.CylinderGeometry(0.03, 0.04, h2, 7), mat(PALETTE.mushStem, 0.8), 0.14, h2 / 2, 0.05);
    const c2 = put(g, new THREE.SphereGeometry(0.08, 9, 7), mat(PALETTE.mushCap, 0.75), 0.14, h2 + 0.01, 0.05);
    c2.scale.set(1, 0.6, 1);
  }
  return g;
}
function buildFern(rng) {
  const g = new THREE.Group();
  const m = mat(PALETTE.leafC, 0.85);
  const fronds = 6 + Math.floor(rng() * 3);
  for (let i = 0; i < fronds; i++) {
    const L = 0.7 + rng() * 0.35;
    const ang = (i / fronds) * Math.PI * 2 + rng() * 0.4;
    const tilt = 0.85 + rng() * 0.35; // strongly arched outward
    const frond = put(g, new THREE.ConeGeometry(0.075, L, 4), m, 0, 0, 0);
    frond.rotation.set(Math.cos(ang) * tilt, ang, Math.sin(ang) * tilt);
    frond.position.set(Math.sin(ang) * L * 0.28, L * 0.32, Math.cos(ang) * L * 0.28);
  }
  return g;
}
function buildFlower(rng, headColor, height = 0.55) {
  const g = new THREE.Group();
  put(g, new THREE.CylinderGeometry(0.014, 0.02, height, 5), mat(PALETTE.leafC), 0, height / 2, 0);
  put(g, new THREE.SphereGeometry(0.085, 10, 8), mat(headColor, 0.7), 0, height + 0.05, 0);
  put(g, new THREE.SphereGeometry(0.032, 8, 6), mat(PALETTE.yellow, 0.6), 0, height + 0.115, 0);
  const leaf = put(g, new THREE.SphereGeometry(0.06, 8, 6), mat(PALETTE.leafB), 0.06, height * 0.45, 0.02);
  leaf.scale.set(1.6, 0.28, 0.7);
  return g;
}
function buildFlowerGroup(rng, headColor) {
  const g = new THREE.Group();
  const n = 3 + Math.floor(rng() * 2);
  for (let i = 0; i < n; i++) {
    const f = buildFlower(rng, headColor, 0.6 + rng() * 0.5);
    const ang = rng() * Math.PI * 2, d = 0.12 + rng() * 0.28;
    f.position.set(Math.cos(ang) * d, 0, Math.sin(ang) * d);
    f.rotation.y = rng() * Math.PI * 2;
    g.add(f);
  }
  const tuft = buildGrass(rng, 0.3, 5, PALETTE.leafB, true);
  g.add(tuft);
  return g;
}
function buildLeafyPlant(rng, size, color) {
  const g = new THREE.Group();
  const m = mat(color, 0.85);
  const leaves = 6 + Math.floor(rng() * 3);
  for (let i = 0; i < leaves; i++) {
    const L = size * (0.7 + rng() * 0.45);
    const ang = (i / leaves) * Math.PI * 2 + rng() * 0.5;
    const tilt = 0.35 + rng() * 0.4;
    const leaf = put(g, new THREE.ConeGeometry(size * 0.13, L, 4), m);
    leaf.rotation.set(Math.cos(ang) * tilt, ang, Math.sin(ang) * tilt);
    leaf.position.set(Math.sin(ang) * L * 0.18, L * 0.42, Math.cos(ang) * L * 0.18);
  }
  put(g, new THREE.SphereGeometry(size * 0.14, 8, 6), mat(PALETTE.leafC), 0, size * 0.1, 0);
  return g;
}
function buildLaetiporus(rng) {
  const g = new THREE.Group();
  put(g, new THREE.CylinderGeometry(0.22, 0.3, 0.5, 8), mat(PALETTE.trunkDark), 0, 0.25, 0);
  const shelfM = mat(PALETTE.laet, 0.7);
  for (let i = 0; i < 3; i++) {
    const y = 0.35 + i * 0.28;
    const r = 0.55 - i * 0.12 + rng() * 0.06;
    const shelf = put(g, new THREE.SphereGeometry(r, 10, 7), shelfM, (rng() - 0.5) * 0.15, y, (rng() - 0.5) * 0.15);
    shelf.scale.set(1, 0.32, 1);
  }
  return g;
}
function buildBush(rng, size, withFlowers) {
  const g = new THREE.Group();
  const leafM = mat(rng() > 0.5 ? PALETTE.leafA : PALETTE.leafC, 0.9);
  const blobs = 3 + Math.floor(rng() * 2);
  const blobCenters = [];
  for (let i = 0; i < blobs; i++) {
    const r = size * (0.32 + rng() * 0.18);
    const ang = rng() * Math.PI * 2, d = size * 0.22 * rng();
    const c = { x: Math.cos(ang) * d, y: r * 0.82, z: Math.sin(ang) * d, r };
    blobCenters.push(c);
    const blob = put(g, new THREE.SphereGeometry(r, 12, 10), leafM, c.x, c.y, c.z);
    blob.scale.set(1, 0.88, 1);
  }
  if (withFlowers) {
    const cols = [PALETTE.pink, PALETTE.white, PALETTE.yellow];
    for (let i = 0; i < 10; i++) {
      const c = blobCenters[Math.floor(rng() * blobCenters.length)];
      const th = rng() * Math.PI * 2, ph = rng() * Math.PI * 0.55;
      put(g, new THREE.SphereGeometry(size * 0.05, 6, 5),
        mat(cols[Math.floor(rng() * cols.length)], 0.6),
        c.x + Math.sin(ph) * Math.cos(th) * c.r, c.y + Math.cos(ph) * c.r * 0.85,
        c.z + Math.sin(ph) * Math.sin(th) * c.r);
    }
  }
  return g;
}
function buildPine(rng, height) {
  const g = new THREE.Group();
  const trunkH = height * 0.22;
  put(g, new THREE.CylinderGeometry(height * 0.028, height * 0.045, trunkH, 7), mat(PALETTE.trunkDark), 0, trunkH / 2, 0);
  const m = mat(rng() > 0.5 ? PALETTE.pine : PALETTE.pineDark, 0.9);
  const layers = 3;
  for (let i = 0; i < layers; i++) {
    const f = i / layers;
    const r = height * (0.24 - f * 0.13) * (0.92 + rng() * 0.16);
    const h = height * 0.34;
    put(g, new THREE.ConeGeometry(r, h, 8), m, 0, trunkH + h * 0.42 + f * height * 0.52, 0, 0, rng() * Math.PI);
  }
  return g;
}
function buildCommonTree(rng, height) {
  const g = new THREE.Group();
  const trunkH = height * 0.48;
  put(g, new THREE.CylinderGeometry(height * 0.035, height * 0.06, trunkH, 8), mat(PALETTE.trunk), 0, trunkH / 2, 0);
  const m = mat([PALETTE.leafA, PALETTE.leafB, PALETTE.leafC][Math.floor(rng() * 3)], 0.9);
  const main = put(g, new THREE.SphereGeometry(height * 0.27, 14, 11), m, 0, trunkH + height * 0.18, 0);
  main.scale.set(1, 0.92, 1);
  for (let i = 0; i < 2; i++) {
    const ang = rng() * Math.PI * 2;
    const r = height * (0.15 + rng() * 0.06);
    put(g, new THREE.SphereGeometry(r, 12, 9), m,
      Math.cos(ang) * height * 0.2, trunkH + height * (0.08 + rng() * 0.14), Math.sin(ang) * height * 0.2);
  }
  return g;
}
function buildTwistedTree(rng, height) {
  const g = new THREE.Group();
  const tm = mat(PALETTE.trunkDark);
  const lean = 0.22 + rng() * 0.15;
  const h1 = height * 0.34;
  const seg1 = put(g, new THREE.CylinderGeometry(height * 0.04, height * 0.062, h1, 7), tm);
  seg1.rotation.z = lean;
  seg1.position.set(Math.sin(lean) * h1 * 0.5, Math.cos(lean) * h1 * 0.5, 0);
  const topX = Math.sin(lean) * h1, topY = Math.cos(lean) * h1;
  const h2 = height * 0.3;
  const seg2 = put(g, new THREE.CylinderGeometry(height * 0.028, height * 0.042, h2, 7), tm);
  seg2.rotation.z = -lean * 1.4;
  seg2.position.set(topX - Math.sin(lean * 1.4) * h2 * 0.5, topY + Math.cos(lean * 1.4) * h2 * 0.5, 0);
  const crownX = topX - Math.sin(lean * 1.4) * h2, crownY = topY + Math.cos(lean * 1.4) * h2;
  const m = mat(PALETTE.leafD, 0.9);
  const c1 = put(g, new THREE.SphereGeometry(height * 0.24, 13, 10), m, crownX, crownY + height * 0.1, 0);
  c1.scale.set(1.15, 0.75, 1.05);
  put(g, new THREE.SphereGeometry(height * 0.14, 11, 9), m, crownX - height * 0.18, crownY - height * 0.02, height * 0.1);
  return g;
}
function buildDeadTree(rng, height) {
  const g = new THREE.Group();
  const m = mat(PALETTE.dead, 0.95);
  const trunkH = height * 0.85;
  const trunk = put(g, new THREE.CylinderGeometry(height * 0.022, height * 0.055, trunkH, 7), m, 0, trunkH / 2, 0);
  trunk.rotation.z = (rng() - 0.5) * 0.12;
  const branches = 3 + Math.floor(rng() * 2);
  for (let i = 0; i < branches; i++) {
    const by = trunkH * (0.45 + rng() * 0.45);
    const L = height * (0.22 + rng() * 0.22);
    const ang = rng() * Math.PI * 2, tilt = 0.7 + rng() * 0.55;
    const b = put(g, new THREE.CylinderGeometry(height * 0.008, height * 0.018, L, 5), m);
    b.rotation.set(Math.cos(ang) * tilt, ang, Math.sin(ang) * tilt);
    b.position.set(Math.sin(ang) * L * 0.35, by + L * 0.3, Math.cos(ang) * L * 0.35);
  }
  return g;
}

function buildPlaceholder(name, rng) {
  if (name.startsWith("Clover")) return buildClover(rng);
  if (name === "Grass_Common_Short") return buildGrass(rng, 0.34, 7, PALETTE.leafA);
  if (name === "Grass_Wispy_Short") return buildGrass(rng, 0.38, 5, PALETTE.leafD, true);
  if (name === "Mushroom_Common") return buildMushroom(rng);
  if (name === "Grass_Common_Tall") return buildGrass(rng, 0.9, 8, PALETTE.leafA);
  if (name === "Grass_Wispy_Tall") return buildGrass(rng, 1.0, 6, PALETTE.leafD, true);
  if (name === "Fern_1") return buildFern(rng);
  if (name === "Flower_3_Single") return buildFlower(rng, PALETTE.yellow, 0.6 + rng() * 0.2);
  if (name === "Flower_4_Single") return buildFlower(rng, rng() > 0.5 ? PALETTE.pink : PALETTE.violet, 0.6 + rng() * 0.2);
  if (name === "Plant_1") return buildLeafyPlant(rng, 0.8, PALETTE.leafA);
  if (name === "Plant_7") return buildLeafyPlant(rng, 0.85, PALETTE.leafC);
  if (name === "Flower_3_Group") return buildFlowerGroup(rng, PALETTE.yellow);
  if (name === "Flower_4_Group") return buildFlowerGroup(rng, PALETTE.pink);
  if (name === "Plant_1_Big") return buildLeafyPlant(rng, 1.45, PALETTE.leafA);
  if (name === "Plant_7_Big") return buildLeafyPlant(rng, 1.5, PALETTE.leafC);
  if (name === "Mushroom_Laetiporus") return buildLaetiporus(rng);
  if (name === "Bush_Common") return buildBush(rng, 1.45, false);
  if (name === "Bush_Common_Flowers") return buildBush(rng, 2.3, true);
  if (name.startsWith("Pine")) return buildPine(rng, 2.8 + rng() * 0.7);
  if (name.startsWith("CommonTree")) return buildCommonTree(rng, 4.6 + rng() * 0.9);
  if (name.startsWith("TwistedTree")) return buildTwistedTree(rng, 4.2 + rng() * 0.9);
  if (name.startsWith("DeadTree")) return buildDeadTree(rng, 2.6);
  return buildGrass(rng, 0.4, 5, PALETTE.leafA); // safe fallback
}

/* Loads the real GLTF for modelName (cached per name) and hands back a fresh
   clone for this plant instance. Falls back to the primitive placeholder if
   there's no file for that name or loading fails for any reason — growth,
   wind, wilting and persistence all flow through unchanged either way. */
async function loadModelForTier(modelName) {
  if (!MODEL_FILES[modelName]) return null;
  const template = await loadGLTFTemplate(modelName);
  return template ? template.clone(true) : null;
}

/* The single factory every plant goes through. */
async function createPlantModel(name, seed) {
  const real = await loadModelForTier(name);
  if (real) return real;
  return buildPlaceholder(name, mulberry32(seed));
}

/* ────────────────────────────── wind system ─────────────────────────────
   A vertex-shader displacement injected into every plant material.
   Strength is weighted by (localY / plantHeight)² — zero at the roots,
   strongest at the crown — so plants read as grounded and swaying,
   not wobbling stickers. Works identically on GLTF scenes.              */

const sharedWindTime = { value: 0 };
let globalWindScale = 1; // reduced-motion support

function applyWindToMesh(mesh, plantHeight, yOffset, phase) {
  const strength = (0.018 + plantHeight * 0.02) * globalWindScale;
  const speed = 1.7 / (1 + plantHeight * 0.16);
  mesh.material = mesh.material.clone();
  mesh.material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = sharedWindTime;
    shader.uniforms.uHeight = { value: Math.max(plantHeight, 0.001) };
    shader.uniforms.uYOff = { value: yOffset };
    shader.uniforms.uStr = { value: strength };
    shader.uniforms.uSpeed = { value: speed };
    shader.uniforms.uPhase = { value: phase };
    shader.vertexShader =
      `uniform float uTime;\nuniform float uHeight;\nuniform float uYOff;\nuniform float uStr;\nuniform float uSpeed;\nuniform float uPhase;\n` +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        `vec3 transformed = vec3(position);
         float groveY = transformed.y + uYOff;
         float hf = clamp(groveY / uHeight, 0.0, 1.0);
         hf = hf * hf;
         float wt = uTime * uSpeed + uPhase;
         float swayX = sin(wt + groveY * 0.6) * 0.7 + sin(wt * 1.7 + groveY) * 0.3;
         float swayZ = cos(wt * 0.8 + groveY * 0.5) * 0.6 + sin(wt * 1.3 + uPhase) * 0.4;
         transformed.x += swayX * uStr * hf;
         transformed.z += swayZ * uStr * hf * 0.7;`
      );
  };
  mesh.material.needsUpdate = true;
}

/* Normalizes a plant (placeholder OR loaded GLTF scene): base at y=0,
   shadows on, wind applied per-mesh with correct world-space Y offsets. */
function preparePlant(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const baseShift = -box.min.y;
  root.position.y += baseShift; // sit exactly on the ground
  root.updateMatrixWorld(true);
  const height = Math.max(box.max.y - box.min.y, 0.05);
  const phase = (hashString(root.uuid) % 1000) / 1000 * Math.PI * 2;
  const v = new THREE.Vector3();
  root.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = false;
      child.getWorldPosition(v);
      const yOffset = v.y - root.position.y + baseShift; // mesh origin height within the plant
      applyWindToMesh(child, height, Math.max(yOffset, 0), phase);
    }
  });
  root.userData.plantHeight = height;
  return root;
}

/* ═══════════════════════════ main component ═══════════════════════════ */

export default function Grove() {
  const mountRef = useRef(null);
  const apiRef = useRef(null);       // imperative scene API
  const gardenRef = useRef(null);    // authoritative garden data
  const activeRef = useRef(null);    // { session, group, endsAt } while growing
  const modeRef = useRef("loading");

  const [mode, setMode] = useState("loading"); // loading | idle | running | resume
  const [picked, setPicked] = useState("small");
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  const [toast, setToast] = useState(null);
  const [stats, setStats] = useState({ plants: 0, minutes: 0 });
  const [resumeInfo, setResumeInfo] = useState(null);
  const toastTimer = useRef(null);

  useEffect(() => { modeRef.current = mode; }, [mode]);

  const showToast = useCallback((text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  }, []);

  const refreshStats = useCallback(() => {
    const g = gardenRef.current;
    if (!g) return;
    const done = g.plants.filter((p) => p.status === "complete");
    setStats({ plants: done.length, minutes: done.reduce((a, p) => a + (p.durationMin || 0), 0) });
  }, []);

  /* ─────────────── scene construction (runs once) ─────────────── */
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;
    let raf = 0;

    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    globalWindScale = reduceMotion ? 0.25 : 1;

    /* renderer / scene / camera */
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.02;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const skyColor = new THREE.Color(0xecefdc);
    scene.background = skyColor;
    scene.fog = new THREE.Fog(skyColor, 34, 72);

    const camera = new THREE.PerspectiveCamera(42, mount.clientWidth / mount.clientHeight, 0.1, 200);

    /* lights — warm late-afternoon */
    const sun = new THREE.DirectionalLight(0xffe6bd, 1.25);
    sun.position.set(14, 20, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -28; sun.shadow.camera.right = 28;
    sun.shadow.camera.top = 28; sun.shadow.camera.bottom = -28;
    sun.shadow.camera.far = 60;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);
    scene.add(new THREE.HemisphereLight(0xd9ecff, 0x9c8a63, 0.55));

    /* procedural ground — soft grass noise on a diorama disc */
    const gc = document.createElement("canvas");
    gc.width = gc.height = 512;
    const gctx = gc.getContext("2d");
    gctx.fillStyle = "#79a55f";
    gctx.fillRect(0, 0, 512, 512);
    const groundRng = mulberry32(1234);
    const blotches = ["#6f9c55", "#84b168", "#719a58", "#8db974", "#7fae66"];
    for (let i = 0; i < 520; i++) {
      gctx.fillStyle = blotches[Math.floor(groundRng() * blotches.length)];
      gctx.globalAlpha = 0.06 + groundRng() * 0.09;
      gctx.beginPath();
      gctx.arc(groundRng() * 512, groundRng() * 512, 8 + groundRng() * 34, 0, Math.PI * 2);
      gctx.fill();
    }
    gctx.globalAlpha = 1;
    const vign = gctx.createRadialGradient(256, 256, 190, 256, 256, 258);
    vign.addColorStop(0, "rgba(60,80,45,0)");
    vign.addColorStop(1, "rgba(58,76,44,0.35)");
    gctx.fillStyle = vign;
    gctx.fillRect(0, 0, 512, 512);
    const groundTex = new THREE.CanvasTexture(gc);
    groundTex.encoding = THREE.sRGBEncoding;
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(GROUND_RADIUS, 72),
      new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1, metalness: 0 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    /* winding stone path — placeholder RockPath_* pieces along a curve */
    const pathCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-19, 0, -6), new THREE.Vector3(-10, 0, 4),
      new THREE.Vector3(-2, 0, -3), new THREE.Vector3(7, 0, 5),
      new THREE.Vector3(15, 0, -2), new THREE.Vector3(20, 0, 4),
    ]);
    const pathPoints = pathCurve.getSpacedPoints(80);
    const pathRng = mulberry32(777);
    const stoneMats = [mat(PALETTE.stoneA, 0.95), mat(PALETTE.stoneB, 0.95)];
    const stoneCount = 30;
    for (let i = 0; i < stoneCount; i++) {
      const t = i / (stoneCount - 1);
      const p = pathCurve.getPointAt(t);
      const round = i % 2 === 0; // alternate RockPath_Round / RockPath_Square
      const s = 0.42 + pathRng() * 0.22;
      const geo = round
        ? new THREE.CylinderGeometry(s, s * 1.05, 0.09, 9)
        : new THREE.BoxGeometry(s * 1.7, 0.09, s * 1.35);
      const stone = new THREE.Mesh(geo, stoneMats[Math.floor(pathRng() * 2)]);
      stone.position.set(p.x + (pathRng() - 0.5) * 0.5, 0.045, p.z + (pathRng() - 0.5) * 0.5);
      stone.rotation.y = pathRng() * Math.PI;
      stone.castShadow = true;
      stone.receiveShadow = true;
      scene.add(stone);
    }

    /* decor scatter — deterministic from the garden seed; more appears
       as the garden fills (rendered count depends on plant count).     */
    const decorGroup = new THREE.Group();
    scene.add(decorGroup);
    const decorRocks = []; // medium rocks join placement collision checks
    let decorBuiltFor = -1;
    function distToPath(x, z) {
      let d = Infinity;
      for (const p of pathPoints) {
        const dx = p.x - x, dz = p.z - z;
        d = Math.min(d, Math.hypot(dx, dz));
      }
      return d;
    }
    function rebuildDecor(seed, plantCount) {
      const target = plantCount;
      if (decorBuiltFor === target) return;
      decorBuiltFor = target;
      decorGroup.clear();
      decorRocks.length = 0;
      const rng = mulberry32(seed ^ 0x5eed);
      const candidates = [];
      for (let i = 0; i < 140; i++) {
        const ang = rng() * Math.PI * 2, r = 3 + Math.pow(rng(), 0.7) * (GROUND_RADIUS - 4.5);
        candidates.push({ x: Math.cos(ang) * r, z: Math.sin(ang) * r, r1: rng(), r2: rng(), r3: rng() });
      }
      const nRocks = 3;
      const nPebbles = 16 + Math.floor(plantCount / 3) * 2;
      const nPetals = 12 + Math.floor(plantCount / 4) * 3;
      let ci = 0;
      const next = () => candidates[ci++ % candidates.length];
      for (let i = 0; i < nRocks; i++) { // Rock_Medium_1..3 placeholders
        const c = next();
        const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55 + c.r1 * 0.35, 0), mat(PALETTE.stoneB, 0.98));
        rock.scale.set(1, 0.6 + c.r2 * 0.2, 1);
        rock.position.set(c.x, 0.28, c.z);
        rock.rotation.set(c.r1, c.r2 * Math.PI * 2, c.r3 * 0.3);
        rock.castShadow = rock.receiveShadow = true;
        decorGroup.add(rock);
        decorRocks.push({ x: c.x, z: c.z, footprint: 1.6 });
      }
      for (let i = 0; i < nPebbles; i++) { // Pebble_Round / Pebble_Square placeholders
        const c = next();
        const round = i % 2 === 0;
        const s = 0.07 + c.r1 * 0.1;
        const peb = round
          ? new THREE.Mesh(new THREE.SphereGeometry(s, 7, 6), mat(PALETTE.pebble, 0.98))
          : new THREE.Mesh(new THREE.BoxGeometry(s * 1.8, s, s * 1.4), mat(PALETTE.pebble, 0.98));
        if (round) peb.scale.y = 0.55;
        peb.position.set(c.x, s * 0.4, c.z);
        peb.rotation.y = c.r2 * Math.PI * 2;
        peb.castShadow = true;
        decorGroup.add(peb);
      }
      const petalMats = [mat(PALETTE.petalA, 0.7), mat(PALETTE.petalB, 0.7)];
      petalMats.forEach((m) => (m.side = THREE.DoubleSide));
      for (let i = 0; i < nPetals; i++) { // Petal_1..5 placeholders
        const c = next();
        const petal = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.09), petalMats[i % 2]);
        petal.position.set(c.x, 0.012, c.z);
        petal.rotation.set(-Math.PI / 2 + (c.r1 - 0.5) * 0.5, 0, c.r2 * Math.PI * 2);
        decorGroup.add(petal);
      }
    }

    /* ── custom orbit controls (r128 has no bundled OrbitControls) ── */
    const orbit = {
      theta: 0.7, phi: 1.06, radius: 18,
      goal: { theta: 0.7, phi: 1.06, radius: 18, target: new THREE.Vector3(0, 0.9, 0) },
      target: new THREE.Vector3(0, 0.9, 0),
      lastInteract: 0,
    };
    const pointers = new Map();
    let pinchDist = 0;
    const el = renderer.domElement;
    el.style.touchAction = "none";
    const onPointerDown = (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      el.setPointerCapture(e.pointerId);
      orbit.lastInteract = performance.now();
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    };
    const onPointerMove = (e) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      orbit.lastInteract = performance.now();
      if (pointers.size === 1) {
        orbit.goal.theta -= dx * 0.005;
        orbit.goal.phi = Math.min(1.42, Math.max(0.25, orbit.goal.phi - dy * 0.004));
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0) orbit.goal.radius = Math.min(42, Math.max(5, orbit.goal.radius * (pinchDist / d)));
        pinchDist = d;
      }
    };
    const onPointerUp = (e) => { pointers.delete(e.pointerId); pinchDist = 0; };
    const onWheel = (e) => {
      e.preventDefault();
      orbit.lastInteract = performance.now();
      orbit.goal.radius = Math.min(42, Math.max(5, orbit.goal.radius * (1 + e.deltaY * 0.0012)));
    };
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("wheel", onWheel, { passive: false });

    /* ── placement: cluster near the path, spill outward as it fills ── */
    function findSpot(tierKey, plants) {
      const tier = TIERS[tierKey];
      const obstacles = [
        ...plants.map((p) => ({ x: p.x, z: p.z, footprint: TIERS[p.tier]?.footprint ?? 1.5 })),
        ...decorRocks,
      ];
      for (let relax = 0; relax < 3; relax++) {
        const spacingMult = [0.6, 0.45, 0.3][relax];
        for (let i = 0; i < 90; i++) {
          const t = Math.random();
          const p = pathCurve.getPointAt(t);
          const tan = pathCurve.getTangentAt(t);
          const normal = new THREE.Vector3(-tan.z, 0, tan.x);
          const side = Math.random() < 0.5 ? -1 : 1;
          const spill = 1.9 + Math.pow(Math.random(), 1.6) * (2.5 + plants.length * 0.4);
          const pos = p.clone().add(normal.multiplyScalar(side * Math.min(spill, 19)));
          pos.x += (Math.random() - 0.5) * 1.4;
          pos.z += (Math.random() - 0.5) * 1.4;
          if (Math.hypot(pos.x, pos.z) > PLANT_LIMIT_RADIUS) continue;
          if (distToPath(pos.x, pos.z) < 1.35 + tier.footprint * 0.25) continue; // stay off the stones
          const ok = obstacles.every(
            (o) => Math.hypot(o.x - pos.x, o.z - pos.z) > (o.footprint + tier.footprint) * spacingMult
          );
          if (ok) return { x: pos.x, z: pos.z };
        }
      }
      // garden is truly packed — tuck it at the fringe
      const ang = Math.random() * Math.PI * 2;
      return { x: Math.cos(ang) * (PLANT_LIMIT_RADIUS - 1), z: Math.sin(ang) * (PLANT_LIMIT_RADIUS - 1) };
    }

    /* ── plant lifecycle in the scene ── */
    const plantGroups = new Map(); // id → group
    const appearing = [];          // { group, t0, dur, from, to }
    const popping = [];            // { group, t0, base }
    const bursts = [];             // particle systems

    async function spawnRecord(rec, animateIn = false) {
      const root = await createPlantModel(rec.model, hashString(rec.id));
      if (disposed) return;
      preparePlant(root);
      root.position.x = rec.x;
      root.position.z = rec.z;
      root.rotation.y = rec.rotY;
      const target = rec.status === "wilted"
        ? (TIERS[rec.tier]?.deadScale ?? 0.6) * rec.scaleVar
        : rec.scaleVar;
      if (animateIn) {
        root.scale.setScalar(0.01);
        appearing.push({ group: root, t0: performance.now(), dur: 700, from: 0.01, to: target });
      } else {
        root.scale.setScalar(target);
      }
      scene.add(root);
      plantGroups.set(rec.id, root);
      return root;
    }

    async function startGrowing(session) {
      const root = await createPlantModel(session.model, hashString(session.id));
      if (disposed) return;
      preparePlant(root);
      root.position.x = session.x;
      root.position.z = session.z;
      root.rotation.y = session.rotY;
      const endsAt = session.startedAt + session.durationMin * MS_PER_MIN;
      const prog = Math.min(Math.max((Date.now() - session.startedAt) / (endsAt - session.startedAt), 0), 1);
      root.scale.setScalar(session.scaleVar * growthScale(prog));
      scene.add(root);
      activeRef.current = { session, group: root, endsAt };
      focusOn(session.x, session.z, root.userData.plantHeight * session.scaleVar);
    }

    function celebrate(group) {
      const h = (group.userData.plantHeight || 1) * group.scale.x;
      popping.push({ group, t0: performance.now(), base: group.scale.x });
      const count = 26;
      const positions = new Float32Array(count * 3);
      const velocities = [];
      for (let i = 0; i < count; i++) {
        positions[i * 3] = group.position.x + (Math.random() - 0.5) * 0.4;
        positions[i * 3 + 1] = group.position.y + h * (0.6 + Math.random() * 0.4);
        positions[i * 3 + 2] = group.position.z + (Math.random() - 0.5) * 0.4;
        const ang = Math.random() * Math.PI * 2;
        velocities.push(new THREE.Vector3(Math.cos(ang) * (0.4 + Math.random()), 1.4 + Math.random() * 1.6, Math.sin(ang) * (0.4 + Math.random())));
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const pm = new THREE.PointsMaterial({ color: 0xf6d78a, size: 0.14, transparent: true, opacity: 1, sizeAttenuation: true, depthWrite: false });
      const pts = new THREE.Points(geo, pm);
      scene.add(pts);
      bursts.push({ pts, velocities, t0: performance.now(), dur: 1600 });
    }

    function finishActive() {
      const a = activeRef.current;
      if (!a) return null;
      a.group.scale.setScalar(a.session.scaleVar);
      celebrate(a.group);
      plantGroups.set(a.session.id, a.group);
      activeRef.current = null;
      return a.session;
    }

    async function wiltActive(deadModel) {
      const a = activeRef.current;
      if (!a) return null;
      const current = a.group.scale.x;
      scene.remove(a.group);
      const deadRoot = await createPlantModel(deadModel, hashString(a.session.id + "-dead"));
      if (disposed) return null;
      preparePlant(deadRoot);
      deadRoot.position.x = a.session.x;
      deadRoot.position.z = a.session.z;
      deadRoot.rotation.y = a.session.rotY;
      const target = (TIERS[a.session.tier]?.deadScale ?? 0.6) * a.session.scaleVar;
      deadRoot.scale.setScalar(Math.max(current * 0.6, 0.01));
      appearing.push({ group: deadRoot, t0: performance.now(), dur: 750, from: deadRoot.scale.x, to: target });
      scene.add(deadRoot);
      plantGroups.set(a.session.id, deadRoot);
      const session = a.session;
      activeRef.current = null;
      return session;
    }

    function focusOn(x, z, plantHeight = 1.5) {
      orbit.goal.target.set(x, Math.max(0.6, plantHeight * 0.4), z);
      orbit.goal.radius = Math.min(20, Math.max(6.5, 5 + plantHeight * 2.6));
    }
    function focusOverview() {
      orbit.goal.target.set(0, 0.9, 0);
      orbit.goal.radius = 18;
    }

    apiRef.current = {
      findSpot, spawnRecord, startGrowing, finishActive, wiltActive,
      focusOn, focusOverview, rebuildDecor,
      onSessionComplete: null, // wired up by React below
    };

    /* ── render loop ── */
    const clock = new THREE.Clock();
    function frame() {
      raf = requestAnimationFrame(frame);
      const now = performance.now();
      sharedWindTime.value = clock.getElapsedTime();

      // active growth (wall-clock driven)
      const a = activeRef.current;
      if (a) {
        const wall = Date.now();
        const total = a.endsAt - a.session.startedAt;
        const prog = Math.min(Math.max((wall - a.session.startedAt) / total, 0), 1);
        a.group.scale.setScalar(a.session.scaleVar * growthScale(prog));
        if (wall >= a.endsAt && apiRef.current.onSessionComplete) {
          const cb = apiRef.current.onSessionComplete;
          apiRef.current.onSessionComplete = null; // fire once
          cb();
        }
      }

      // appear tweens (load-in, wilt swap)
      for (let i = appearing.length - 1; i >= 0; i--) {
        const ap = appearing[i];
        const k = Math.min((now - ap.t0) / ap.dur, 1);
        ap.group.scale.setScalar(ap.from + (ap.to - ap.from) * easeOutCubic(k));
        if (k >= 1) appearing.splice(i, 1);
      }
      // celebratory pop (scale overshoot spring)
      for (let i = popping.length - 1; i >= 0; i--) {
        const pp = popping[i];
        const k = (now - pp.t0) / 900;
        if (k >= 1) { pp.group.scale.setScalar(pp.base); popping.splice(i, 1); continue; }
        pp.group.scale.setScalar(pp.base * (1 + 0.16 * Math.sin(k * Math.PI) * (1 - k * 0.5)));
      }
      // particle bursts
      for (let i = bursts.length - 1; i >= 0; i--) {
        const b = bursts[i];
        const k = (now - b.t0) / b.dur;
        if (k >= 1) { scene.remove(b.pts); b.pts.geometry.dispose(); b.pts.material.dispose(); bursts.splice(i, 1); continue; }
        const pos = b.pts.geometry.attributes.position;
        const dt = 1 / 60;
        for (let j = 0; j < b.velocities.length; j++) {
          b.velocities[j].y -= 2.6 * dt;
          pos.array[j * 3] += b.velocities[j].x * dt;
          pos.array[j * 3 + 1] += b.velocities[j].y * dt;
          pos.array[j * 3 + 2] += b.velocities[j].z * dt;
        }
        pos.needsUpdate = true;
        b.pts.material.opacity = 1 - k;
      }

      // idle drift: a slow diorama turn when the garden is just being admired
      if (!reduceMotion && modeRef.current === "idle" && now - orbit.lastInteract > 6000) {
        orbit.goal.theta += 0.00045;
      }

      // damped orbit
      const d = 0.085;
      orbit.theta += (orbit.goal.theta - orbit.theta) * d;
      orbit.phi += (orbit.goal.phi - orbit.phi) * d;
      orbit.radius += (orbit.goal.radius - orbit.radius) * d;
      orbit.target.lerp(orbit.goal.target, d);
      camera.position.set(
        orbit.target.x + orbit.radius * Math.sin(orbit.phi) * Math.sin(orbit.theta),
        orbit.target.y + orbit.radius * Math.cos(orbit.phi),
        orbit.target.z + orbit.radius * Math.sin(orbit.phi) * Math.cos(orbit.theta)
      );
      camera.lookAt(orbit.target);
      renderer.render(scene, camera);
    }
    frame();

    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener("resize", onResize);

    /* ── load persisted state, then hand control to the UI ── */
    (async () => {
      let garden = await storeGet(K_GARDEN);
      if (!garden) {
        garden = { seed: Math.floor(Math.random() * 2 ** 31), plants: [] };
        await storeSet(K_GARDEN, garden);
      }
      gardenRef.current = garden;
      rebuildDecor(garden.seed, garden.plants.length);
      for (const rec of garden.plants) await spawnRecord(rec, false);
      refreshStats();

      const session = await storeGet(K_SESSION);
      if (session) {
        const endsAt = session.startedAt + session.durationMin * MS_PER_MIN;
        if (Date.now() >= endsAt) {
          // it finished growing while they were away — honor the completed focus
          const rec = { ...session, status: "complete", completedAt: endsAt };
          delete rec.startedAt;
          rec.plantedAt = session.startedAt;
          garden.plants.push(rec);
          await storeSet(K_GARDEN, garden);
          await storeDelete(K_SESSION);
          await spawnRecord(rec, true);
          rebuildDecor(garden.seed, garden.plants.length);
          refreshStats();
          showToast(`While you were away, your ${friendlyName(session.model)} finished growing.`);
          setMode("idle");
        } else {
          await startGrowing(session);
          setResumeInfo(session);
          setMode("resume");
        }
      } else {
        setMode("idle");
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("wheel", onWheel);
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ─────────────── session actions (React side) ─────────────── */

  const completeSession = useCallback(async () => {
    const api = apiRef.current;
    const finished = api.finishActive();
    if (!finished) return;
    const garden = gardenRef.current;
    const rec = {
      id: finished.id, model: finished.model, tier: finished.tier,
      durationMin: finished.durationMin, x: finished.x, z: finished.z,
      rotY: finished.rotY, scaleVar: finished.scaleVar,
      status: "complete", plantedAt: finished.startedAt, completedAt: Date.now(),
    };
    garden.plants.push(rec);
    await storeSet(K_GARDEN, garden);
    await storeDelete(K_SESSION);
    api.rebuildDecor(garden.seed, garden.plants.length);
    refreshStats();
    showToast(`Your ${friendlyName(finished.model)} has taken root.`);
    setConfirmQuit(false);
    setMode("idle");
    setTimeout(() => { if (modeRef.current === "idle") apiRef.current?.focusOverview(); }, 3000);
  }, [refreshStats, showToast]);

  const startSession = useCallback(async (tierKey) => {
    const api = apiRef.current;
    const garden = gardenRef.current;
    if (!api || !garden || activeRef.current) return;
    const tier = TIERS[tierKey];
    const model = tier.models[Math.floor(Math.random() * tier.models.length)];
    const spot = api.findSpot(tierKey, garden.plants);
    const session = {
      id: `p-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      model, tier: tierKey, durationMin: tier.minutes,
      x: spot.x, z: spot.z, rotY: Math.random() * Math.PI * 2,
      scaleVar: 0.85 + Math.random() * 0.3,
      startedAt: Date.now(),
    };
    await storeSet(K_SESSION, session);
    api.onSessionComplete = completeSession;
    await api.startGrowing(session);
    setConfirmQuit(false);
    setMode("running");
  }, [completeSession]);

  const wiltSession = useCallback(async () => {
    const api = apiRef.current;
    const active = activeRef.current;
    if (!api || !active) return;
    const deadModel = DEAD_MODELS[Math.floor(Math.random() * DEAD_MODELS.length)];
    api.onSessionComplete = null;
    const session = await api.wiltActive(deadModel);
    if (!session) return;
    const garden = gardenRef.current;
    garden.plants.push({
      id: session.id, model: deadModel, tier: session.tier,
      durationMin: 0, x: session.x, z: session.z,
      rotY: session.rotY, scaleVar: session.scaleVar,
      status: "wilted", plantedAt: session.startedAt, completedAt: Date.now(),
    });
    await storeSet(K_GARDEN, garden);
    await storeDelete(K_SESSION);
    refreshStats();
    showToast(`The ${friendlyName(session.model)} wilted. It stays as a reminder.`);
    setConfirmQuit(false);
    setResumeInfo(null);
    setMode("idle");
    setTimeout(() => { if (modeRef.current === "idle") apiRef.current?.focusOverview(); }, 2500);
  }, [refreshStats, showToast]);

  const resumeSession = useCallback(() => {
    if (!activeRef.current || !apiRef.current) return;
    apiRef.current.onSessionComplete = completeSession;
    setResumeInfo(null);
    setMode("running");
  }, [completeSession]);

  /* UI clock tick while a session is live or awaiting resume */
  useEffect(() => {
    if (mode !== "running" && mode !== "resume") return;
    const t = setInterval(() => setNowTick(Date.now()), 400);
    return () => clearInterval(t);
  }, [mode]);

  /* ─────────────────────────────── UI ─────────────────────────────── */

  const active = activeRef.current;
  const remainingMs = active ? Math.max(0, active.endsAt - nowTick) : 0;
  const totalMs = active ? active.session.durationMin * MS_PER_MIN : 1;
  const progress = active ? Math.min(1, 1 - remainingMs / totalMs) : 0;

  const RING_R = 17;
  const RING_C = 2 * Math.PI * RING_R;

  const font = { fontFamily: "Georgia, 'Iowan Old Style', 'Times New Roman', serif" };
  const sans = { fontFamily: "-apple-system, 'Segoe UI', system-ui, sans-serif" };

  const card = {
    background: "rgba(250, 249, 240, 0.88)",
    backdropFilter: "blur(10px)",
    WebkitBackdropFilter: "blur(10px)",
    border: "1px solid rgba(90, 105, 70, 0.18)",
    borderRadius: 18,
    boxShadow: "0 10px 34px rgba(50, 65, 38, 0.16)",
  };
  const btnBase = {
    ...sans, border: "none", cursor: "pointer", borderRadius: 12,
    fontSize: 14, fontWeight: 600, padding: "10px 18px",
    transition: "transform 120ms ease, box-shadow 120ms ease, background 120ms ease",
  };
  const btnPrimary = { ...btnBase, background: "#4a6b3f", color: "#f7f5ea", boxShadow: "0 3px 10px rgba(58, 84, 48, 0.35)" };
  const btnGhost = { ...btnBase, background: "transparent", color: "#5c6b4d", border: "1px solid rgba(90,105,70,0.3)" };

  return (
    <div className="grove-app" style={{ position: "relative", overflow: "hidden", background: "#ecefdc" }}>
      <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />

      {/* TEMPORARY: test-mode badge — remove alongside MS_PER_MIN */}
      {TEST_MODE && (
        <div style={{
          position: "absolute", top: 20, right: 24, pointerEvents: "none",
          ...sans, fontSize: 12, fontWeight: 700, letterSpacing: "0.06em",
          color: "#92400e", background: "rgba(253, 230, 138, 0.9)",
          border: "1px solid rgba(146, 64, 14, 0.4)", borderRadius: 8,
          padding: "5px 10px",
        }}>
          TEST MODE · {TEST_TIME_SCALE}× SPEED
        </div>
      )}

      {/* wordmark + garden stats */}
      <div style={{ position: "absolute", top: 20, left: 24, pointerEvents: "none", color: "#38452e" }}>
        <div style={{ ...font, fontSize: 26, letterSpacing: "0.5px" }}>Grove</div>
        {stats.plants > 0 && (
          <div style={{ ...sans, fontSize: 12.5, opacity: 0.72, marginTop: 3 }}>
            {stats.plants} plant{stats.plants === 1 ? "" : "s"} · {fmtTotal(stats.minutes)} of focus grown
          </div>
        )}
      </div>

      {/* loading veil */}
      {mode === "loading" && (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "#ecefdc" }}>
          <div style={{ ...font, fontSize: 18, color: "#5c6b4d" }}>Tending the garden…</div>
        </div>
      )}

      {/* idle: duration picker */}
      {mode === "idle" && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 26, display: "flex", justifyContent: "center", padding: "0 16px" }}>
          <div style={{ ...card, padding: "18px 20px 16px", maxWidth: 560, width: "100%" }}>
            <div style={{ ...sans, fontSize: 11.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "#7a8a66", marginBottom: 10 }}>
              Plant a session
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
              {TIER_ORDER.map((k) => {
                const t = TIERS[k];
                const sel = picked === k;
                return (
                  <button
                    key={k}
                    onClick={() => setPicked(k)}
                    style={{
                      ...btnBase, flex: "1 1 88px", padding: "10px 6px",
                      background: sel ? "#e4ecd6" : "rgba(255,255,255,0.55)",
                      border: sel ? "1.5px solid #4a6b3f" : "1.5px solid rgba(90,105,70,0.18)",
                      color: "#38452e", display: "flex", flexDirection: "column", gap: 2, alignItems: "center",
                    }}
                  >
                    <span style={{ fontSize: 15, fontWeight: 700 }}>{t.label}</span>
                    <span style={{ fontSize: 11.5, opacity: 0.66, fontWeight: 500 }}>{t.noun}</span>
                  </button>
                );
              })}
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div style={{ ...sans, fontSize: 12.5, color: "#6c7a5a", lineHeight: 1.4 }}>
                Stay the full {TIERS[picked].label} and a {TIERS[picked].noun.toLowerCase()} takes root. Leave early and it wilts.
              </div>
              <button
                style={{ ...btnPrimary, whiteSpace: "nowrap", fontSize: 15, padding: "12px 26px" }}
                onClick={() => startSession(picked)}
              >
                Plant
              </button>
            </div>
          </div>
        </div>
      )}

      {/* running: timer ring with milestone ticks */}
      {mode === "running" && active && (
        <div style={{ position: "absolute", top: 18, left: 0, right: 0, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
          <div style={{ ...card, padding: "12px 20px 12px 14px", display: "flex", alignItems: "center", gap: 14, pointerEvents: "auto" }}>
            <svg width="46" height="46" viewBox="0 0 46 46" aria-hidden="true">
              <circle cx="23" cy="23" r={RING_R} fill="none" stroke="rgba(90,105,70,0.18)" strokeWidth="3" />
              <circle
                cx="23" cy="23" r={RING_R} fill="none" stroke="#4a6b3f" strokeWidth="3" strokeLinecap="round"
                strokeDasharray={RING_C} strokeDashoffset={RING_C * (1 - progress)}
                transform="rotate(-90 23 23)" style={{ transition: "stroke-dashoffset 400ms linear" }}
              />
              {/* growth-milestone ticks at ⅓ and ⅔ */}
              {[1 / 3, 2 / 3].map((f) => {
                const a = -Math.PI / 2 + f * Math.PI * 2;
                return (
                  <line key={f}
                    x1={23 + Math.cos(a) * (RING_R - 3)} y1={23 + Math.sin(a) * (RING_R - 3)}
                    x2={23 + Math.cos(a) * (RING_R + 3)} y2={23 + Math.sin(a) * (RING_R + 3)}
                    stroke="#7a8a66" strokeWidth="1.6"
                  />
                );
              })}
            </svg>
            <div>
              <div style={{ ...font, fontSize: 24, color: "#2f3a26", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
                {fmtRemaining(remainingMs)}
              </div>
              <div style={{ ...sans, fontSize: 12, color: "#7a8a66", marginTop: 3 }}>
                {stageName(progress)} · {friendlyName(active.session.model)}
              </div>
            </div>
            {!confirmQuit ? (
              <button style={{ ...btnGhost, fontSize: 12.5, padding: "7px 12px", marginLeft: 6 }} onClick={() => setConfirmQuit(true)}>
                Give up
              </button>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 6 }}>
                <span style={{ ...sans, fontSize: 12, color: "#8a5a44" }}>It will wilt.</span>
                <button style={{ ...btnGhost, fontSize: 12.5, padding: "7px 12px" }} onClick={() => setConfirmQuit(false)}>Keep going</button>
                <button style={{ ...btnBase, fontSize: 12.5, padding: "7px 12px", background: "#a4613f", color: "#f7f2ea" }} onClick={wiltSession}>
                  Let it wilt
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* resume prompt after refresh / return */}
      {mode === "resume" && resumeInfo && (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "rgba(46, 58, 36, 0.28)", backdropFilter: "blur(2px)" }}>
          <div style={{ ...card, padding: "26px 28px", maxWidth: 380, textAlign: "center" }}>
            <div style={{ ...font, fontSize: 21, color: "#2f3a26", marginBottom: 8 }}>Still growing</div>
            <div style={{ ...sans, fontSize: 13.5, color: "#5c6b4d", lineHeight: 1.55, marginBottom: 18 }}>
              You left mid-session. Your {friendlyName(resumeInfo.model)} has{" "}
              <strong style={{ fontVariantNumeric: "tabular-nums" }}>
                {fmtRemaining(resumeInfo.startedAt + resumeInfo.durationMin * MS_PER_MIN - nowTick)}
              </strong>{" "}
              to go — pick the session back up, or let it go.
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button style={btnPrimary} onClick={resumeSession}>Resume focus</button>
              <button style={btnGhost} onClick={wiltSession}>Abandon — it wilts</button>
            </div>
          </div>
        </div>
      )}

      {/* toast */}
      {toast && (
        <div style={{ position: "absolute", bottom: mode === "idle" ? 168 : 30, left: 0, right: 0, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
          <div style={{ ...card, ...sans, padding: "11px 20px", fontSize: 13.5, color: "#38452e", borderRadius: 999 }}>
            {toast}
          </div>
        </div>
      )}
    </div>
  );
}
