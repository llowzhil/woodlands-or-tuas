// Woodlands or Tuas? Compares the free-flow drive through each checkpoint
// (OSRM), shows the live LTA checkpoint cameras (data.gov.sg) and suggests
// places in JB (a hand-kept list plus OpenStreetMap search).

const OSRM = "https://router.project-osrm.org";
const CAMERAS_URL = "https://api.data.gov.sg/v1/transport/traffic-images";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";

const CLOSE_CALL_MIN = 5; // below this difference the drives count as equal
const CAMERA_REFRESH_MS = 60_000;
const STALE_CAMERA_MIN = 10;
const GPS_MAX_AGE_MS = 120_000;
const ROUTE_TIMEOUT_MS = 12_000;

const NEARBY_BOX_DEG = 0.035; // about 4 km each way
const NEARBY_QUERIES = ["mall", "theme park", "museum"];
const NEARBY_MAX = 9;
const NEARBY_DEBOUNCE_MS = 500;
const NOMINATIM_GAP_MS = 1100; // the service allows one request a second
const NEW_PLACE_MONTHS = 12;
const EVENT_LOOKAHEAD_DAYS = 75;

// Each bridge has one pass-through point per carriageway, so a route is
// pinned to the side of the bridge that matches the direction of travel.
// `bearingToJB` is the compass bearing of the JB-bound carriageway.
const CHECKPOINTS = {
  woodlands: {
    name: "Woodlands",
    sub: "Causeway",
    bearingToJB: 345,
    via: {
      toJB: { lat: 1.452723, lng: 103.76907 },
      toSG: { lat: 1.452765, lng: 103.769211 },
    },
    cams: [
      ["2702", "Checkpoint"],
      ["2701", "Causeway"],
      ["2704", "BKE approach"],
    ],
  },
  tuas: {
    name: "Tuas",
    sub: "Second Link",
    bearingToJB: 306,
    via: {
      toJB: { lat: 1.351351, lng: 103.632254 },
      toSG: { lat: 1.351442, lng: 103.632333 },
    },
    cams: [
      ["4713", "Checkpoint"],
      ["4703", "Second Link"],
      ["4712", "AYE approach"],
    ],
  },
};

// Approximate centre points; good enough for comparing two routes.
const SG_PLACES = {
  woodlands: ["Woodlands", 1.436, 103.786],
  yishun: ["Yishun", 1.429, 103.835],
  sengkang: ["Sengkang / Punggol", 1.3917, 103.895],
  amk: ["Ang Mo Kio", 1.37, 103.849],
  tampines: ["Tampines", 1.353, 103.945],
  bedok: ["Bedok", 1.324, 103.93],
  toapayoh: ["Toa Payoh", 1.334, 103.85],
  orchard: ["Orchard / City", 1.304, 103.832],
  queenstown: ["Queenstown", 1.294, 103.806],
  bukittimah: ["Bukit Timah", 1.34, 103.776],
  clementi: ["Clementi", 1.315, 103.765],
  cck: ["Choa Chu Kang", 1.385, 103.745],
  jurongeast: ["Jurong East", 1.3331, 103.7423],
  jurongwest: ["Jurong West", 1.34, 103.706],
};

const JB_PLACES = {
  citysquare: ["City Square / JB Sentral", 1.4625, 103.764],
  ksl: ["KSL City", 1.4853, 103.7625],
  southkey: ["Mid Valley Southkey", 1.501, 103.777],
  tebrau: ["IKEA / Toppen / AEON Tebrau", 1.549, 103.796],
  paradigm: ["Paradigm Mall", 1.5147, 103.6853],
  sutera: ["Sutera Mall", 1.517, 103.67],
  bukitindah: ["AEON Bukit Indah", 1.481, 103.656],
  puteri: ["Puteri Harbour", 1.417, 103.658],
  legoland: ["Legoland", 1.427, 103.631],
  jpo: ["Johor Premium Outlets", 1.6035, 103.6247],
  senai: ["Senai Airport", 1.636, 103.666],
};
const PLACES = { sg: SG_PLACES, jb: JB_PLACES };

const GPS = "gps";
const CUSTOM = "custom"; // a JB destination picked from "Where to go"
const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  dir: "toJB",
  sg: "orchard",
  jb: "citysquare",
  home: { sg: "orchard", jb: "citysquare" }, // last area picked on each side
  gps: null, // { lat, lng } once the browser has given a position
  gpsAt: 0,
  routes: null, // { woodlands: {secs, km}, tuas: {secs, km} }
  cameras: {}, // camera id -> { image, timestamp }
  cameraError: null,
  custom: null, // { name, lat, lng } when the JB side was picked from "Where to go"
  curated: [], // hand-checked entries from curated.json
  nearby: { status: "idle", title: "", items: [], key: null, anchor: null },
};

// ---------- saved choices ----------

function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem("trip") ?? "{}") ?? {};
    if (saved.dir === "toJB" || saved.dir === "toSG") state.dir = saved.dir;
    for (const side of ["sg", "jb"]) {
      if (PLACES[side][saved.home?.[side]]) state.home[side] = saved.home[side];
      if (saved[side] === GPS || PLACES[side][saved[side]]) state[side] = saved[side];
    }
    const c = saved.custom;
    if (saved.jb === CUSTOM && c && typeof c.name === "string" && Number.isFinite(c.lat) && Number.isFinite(c.lng)) {
      state.custom = { name: c.name, lat: c.lat, lng: c.lng };
      state.jb = CUSTOM;
    }
    if (state.sg === GPS && state.jb === GPS) state.jb = state.home.jb;
  } catch {
    // storage unavailable: defaults are fine
  }
}

function save() {
  try {
    const { dir, sg, jb, custom, home } = state;
    localStorage.setItem("trip", JSON.stringify({ dir, sg, jb, custom, home }));
  } catch {
    // ignore
  }
}

// ---------- location ----------

function pointFor(side) {
  const id = state[side];
  if (id === GPS) return state.gps;
  if (id === CUSTOM) return state.custom;
  const [, lat, lng] = PLACES[side][id];
  return { lat, lng };
}

// Northern edge of Singapore: the middle of the Johor Strait, west to east,
// as [longitude, latitude]. Rough, so points within about a kilometre of the
// water can land on the wrong side.
const STRAIT = [
  [103.6, 1.32],
  [103.632, 1.351],
  [103.651, 1.38],
  [103.671, 1.418],
  [103.695, 1.445],
  [103.73, 1.457],
  [103.769, 1.4535],
  [103.8, 1.468],
  [103.835, 1.472],
  [103.875, 1.447],
  [103.92, 1.435],
  [103.97, 1.435],
  [104.09, 1.44],
];

function inSingapore({ lat, lng }) {
  if (lat < 1.15 || lng < STRAIT[0][0] || lng > STRAIT.at(-1)[0]) return false;
  for (let i = 1; i < STRAIT.length; i++) {
    const [x0, y0] = STRAIT[i - 1];
    const [x1, y1] = STRAIT[i];
    if (lng <= x1) return lat < y0 + ((lng - x0) / (x1 - x0)) * (y1 - y0);
  }
  return false;
}

function setGpsStatus(text) {
  const box = $("#gps-status");
  box.hidden = !text;
  box.textContent = text ?? "";
}

const gpsSide = () => (state.sg === GPS ? "sg" : state.jb === GPS ? "jb" : null);
const gpsStale = () => !state.gps || Date.now() - state.gpsAt > GPS_MAX_AGE_MS;

// "My current location" belongs to whichever side of the strait the user is
// actually on. If it was chosen (or saved) for the other side, move it.
function correctGpsSide() {
  const side = gpsSide();
  if (!side || !state.gps) return;
  const actual = inSingapore(state.gps) ? "sg" : "jb";
  if (side === actual) return;
  state[side] = state.home[side];
  state[actual] = GPS;
  if (actual === "jb") state.custom = null;
  setGpsStatus(
    actual === "jb"
      ? "You are on the Malaysian side, so your location is used as the JB side."
      : "You are in Singapore, so your location is used as the Singapore side."
  );
}

let gpsPending = false;

function requestGps() {
  if (gpsPending) return;
  if (!navigator.geolocation) {
    gpsFailed("This browser cannot share a location");
    return;
  }
  gpsPending = true;
  if (!state.gps) setGpsStatus("Finding your location…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      gpsPending = false;
      state.gps = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      state.gpsAt = Date.now();
      setGpsStatus(null);
      refresh();
    },
    () => {
      gpsPending = false;
      gpsFailed("Could not get your location");
    },
    { enableHighAccuracy: false, timeout: 10_000, maximumAge: GPS_MAX_AGE_MS }
  );
}

function gpsFailed(reason) {
  const side = gpsSide();
  if (!side) {
    setGpsStatus(null);
    return;
  }
  if (state.gps) {
    // Keep using the last known position; try again after the usual interval.
    state.gpsAt = Date.now();
    return;
  }
  state[side] = state.home[side];
  setGpsStatus(`${reason}, so this uses ${PLACES[side][state[side]][0]}. Allow location access, or pick your area.`);
  refresh();
}

// ---------- routing ----------

const routeCache = new Map();
let routeRun = 0;

async function driveVia(from, to, cp, dir) {
  const via = cp.via[dir];
  const bearing = dir === "toJB" ? cp.bearingToJB : (cp.bearingToJB + 180) % 360;
  const ll = (p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`;
  const url =
    `${OSRM}/route/v1/driving/${ll(from)};${via.lng},${via.lat};${ll(to)}` +
    `?overview=false&continue_straight=true&bearings=;${bearing},45;&radiuses=;100;`;
  if (routeCache.has(url)) return routeCache.get(url);

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(
      err.name === "TimeoutError" ? "The routing server took too long to answer" : "The routing server could not be reached"
    );
  }
  const json = await res.json().catch(() => null); // error pages are not JSON
  if (json?.code === "Ok" && json.routes?.[0]) {
    const result = { secs: json.routes[0].duration, km: json.routes[0].distance / 1000 };
    routeCache.set(url, result);
    return result;
  }
  if (json?.code === "NoRoute" || json?.code === "NoSegment") {
    throw new Error("No driving route was found between these two points");
  }
  throw new Error(res.status === 429 ? "The routing server is busy" : `The routing server returned an error (${res.status})`);
}

async function updateRoutes() {
  const run = ++routeRun;
  const sg = pointFor("sg");
  const jb = pointFor("jb");
  state.routes = null;
  if (!sg || !jb) {
    renderVerdict({ waitingForGps: true });
    renderCards();
    return;
  }
  renderVerdict({ loading: true });
  renderCards();
  const dir = state.dir;
  const [from, to] = dir === "toJB" ? [sg, jb] : [jb, sg];
  try {
    // One after the other: the public routing server asks for light use.
    const woodlands = await driveVia(from, to, CHECKPOINTS.woodlands, dir);
    const tuas = await driveVia(from, to, CHECKPOINTS.tuas, dir);
    if (run !== routeRun) return;
    state.routes = { woodlands, tuas };
    renderVerdict({});
  } catch (err) {
    if (run !== routeRun) return;
    renderVerdict({ error: err.message });
  }
  renderCards();
}

// ---------- cameras ----------

async function updateCameras() {
  try {
    const res = await fetch(CAMERAS_URL, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Camera feed failed (${res.status})`);
    const json = await res.json();
    const cameras = {};
    for (const cam of json.items?.[0]?.cameras ?? []) {
      cameras[cam.camera_id] = { image: cam.image, timestamp: cam.timestamp };
    }
    state.cameras = cameras;
    state.cameraError = null;
  } catch {
    state.cameraError = "Cameras could not be loaded. Retrying shortly.";
  }
  renderCams();
}

// ---------- rendering ----------

const mins = (secs) => Math.round(secs / 60);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
}

// Positive when Woodlands is the shorter drive; null without routes.
function driveGap() {
  if (!state.routes) return null;
  return mins(state.routes.tuas.secs) - mins(state.routes.woodlands.secs);
}

function renderVerdict({ loading, waitingForGps, error }) {
  const box = $("#verdict");
  box.classList.toggle("error", Boolean(error));
  box.replaceChildren();

  if (waitingForGps) {
    box.append(el("p", { className: "verdict-head", textContent: "Waiting for your location…" }));
    return;
  }
  if (loading) {
    box.append(el("p", { className: "verdict-head", textContent: "Working out your routes…" }));
    return;
  }
  if (error) {
    const retry = el("button", { type: "button", textContent: "Try again" });
    retry.addEventListener("click", updateRoutes);
    box.append(
      el("p", { className: "verdict-head", textContent: "Could not work out the routes" }),
      el("p", { className: "verdict-sub", textContent: `${error}. The cameras below still work.` }),
      retry
    );
    return;
  }

  const diff = driveGap();
  const gap = Math.abs(diff);
  if (gap < CLOSE_CALL_MIN) {
    box.append(
      el("p", { className: "verdict-head", textContent: "Same drive either way" }),
      el("p", {
        className: "verdict-sub",
        textContent: `The two routes are within ${Math.max(gap, 1)} min of driving. Take whichever queue looks shorter on the cameras.`,
      })
    );
    return;
  }
  const [near, far] = diff > 0 ? ["Woodlands", "Tuas"] : ["Tuas", "Woodlands"];
  box.append(
    el("p", { className: "verdict-head", textContent: `${far} costs you ${gap} min more driving` }),
    el("p", {
      className: "verdict-sub",
      textContent: `Take ${near} unless its queue looks at least ${gap} min longer than the queue at ${far}.`,
    })
  );
}

function mapsLink(cp) {
  const sg = pointFor("sg");
  const jb = pointFor("jb");
  if (!sg || !jb) return null;
  const [from, to] = state.dir === "toJB" ? [sg, jb] : [jb, sg];
  const p = (pt) => `${pt.lat.toFixed(6)},${pt.lng.toFixed(6)}`;
  // Google Maps links only take stops, so the bridge shows as a stop. The
  // point sits on the carriageway for this direction of travel.
  const url =
    "https://www.google.com/maps/dir/?api=1&travelmode=driving" +
    `&origin=${p(from)}&destination=${p(to)}&waypoints=${p(cp.via[state.dir])}`;
  return el("a", {
    className: "maps-link",
    href: url,
    target: "_blank",
    rel: "noopener",
    textContent: "Check live time in Google Maps",
  });
}

// Each card has a head (name, drive time, link) and a camera strip. They are
// rendered separately so a route change never rebuilds the camera images.
const camNodes = new Map(); // camera id -> { figure, link, img, time }

function buildCards() {
  for (const id of Object.keys(CHECKPOINTS)) {
    $(`#card-${id}`).replaceChildren(
      el("div", { className: "card-head" }),
      el("div", { className: "cams" }),
      el("p", { className: "cam-missing", textContent: "Loading cameras…" })
    );
  }
}

function renderCards() {
  const diff = driveGap();
  const best = diff === null || Math.abs(diff) < CLOSE_CALL_MIN ? null : diff > 0 ? "woodlands" : "tuas";

  for (const [id, cp] of Object.entries(CHECKPOINTS)) {
    const card = $(`#card-${id}`);
    const route = state.routes?.[id];
    card.classList.toggle("best", best === id);

    const top = el(
      "div",
      { className: "card-top" },
      el("h2", {}, `${cp.name} `, el("small", { textContent: cp.sub })),
      best === id ? el("span", { className: "badge", textContent: "Shorter drive" }) : null
    );
    const drive = el("p", { className: "drive" });
    if (route) {
      drive.append(`${mins(route.secs)} min `, el("small", { textContent: `drive, ${route.km.toFixed(0)} km, no queue` }));
    } else {
      drive.append(el("small", { textContent: "Drive time not available yet" }));
    }
    card.querySelector(".card-head").replaceChildren(...[top, drive, route ? mapsLink(cp) : null].filter(Boolean));
  }
}

function cameraAge(timestamp) {
  const ms = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(ms)) return { age: Infinity, text: "time unknown" };
  const age = Math.max(0, Math.round(ms / 60_000));
  return { age, text: age === 0 ? "just now" : `${age} min ago` };
}

function renderCams() {
  for (const [id, cp] of Object.entries(CHECKPOINTS)) {
    const card = $(`#card-${id}`);
    const strip = card.querySelector(".cams");
    let shown = 0;
    for (const [camId, label] of cp.cams) {
      const cam = state.cameras[camId];
      let node = camNodes.get(camId);
      if (!cam) {
        node?.figure.remove();
        continue;
      }
      if (!node) {
        const img = el("img", { alt: `${cp.name} ${label} traffic camera`, loading: "lazy" });
        const link = el("a", { target: "_blank", rel: "noopener" }, img);
        const time = el("time");
        const figure = el("figure", { className: "cam" }, link, el("figcaption", {}, el("span", { textContent: label }), time));
        node = { figure, link, img, time };
        camNodes.set(camId, node);
      }
      if (node.img.getAttribute("src") !== cam.image) {
        node.img.src = cam.image;
        node.link.href = cam.image;
      }
      const { age, text } = cameraAge(cam.timestamp);
      node.time.dateTime = cam.timestamp;
      node.time.textContent = text;
      node.time.className = age >= STALE_CAMERA_MIN ? "stale" : "";
      strip.append(node.figure); // keeps the fixed order; moving a node does not reload its image
      shown += 1;
    }
    const missing = card.querySelector(".cam-missing");
    missing.hidden = shown > 0;
    missing.textContent = state.cameraError ?? "Loading cameras…";
  }
}

// ---------- where to go ----------

function kmBetween(a, b) {
  const rad = Math.PI / 180;
  const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * 6371;
}

async function loadCurated() {
  try {
    const res = await fetch("curated.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(String(res.status));
    const list = await res.json();
    state.curated = Array.isArray(list) ? list : [];
  } catch {
    state.curated = [];
  }
  renderCurated();
}

const monthFmt = new Intl.DateTimeFormat("en-SG", { month: "short", year: "numeric" });
const dayFmt = new Intl.DateTimeFormat("en-SG", { day: "numeric", month: "short" });

// Reads "YYYY-MM-DD" or "YYYY-MM" as a calendar day in the viewer's own
// timezone, so a date shows as written wherever the page is opened.
// A month alone means its first day, or its last when `monthEnd` is set.
function parseDay(text, monthEnd = false) {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(text ?? "");
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : null];
  const date = d ? new Date(y, mo - 1, d) : monthEnd ? new Date(y, mo, 0) : new Date(y, mo - 1, 1);
  return isNaN(date) ? null : { date, monthOnly: d === null };
}

// Returns { tag, when } for entries worth showing today, or null.
function curatedStatus(item, now = new Date()) {
  if (item.kind === "event") {
    const end = parseDay(item.end ?? item.start, true);
    if (!end) return null;
    const dayAfterEnd = new Date(end.date.getFullYear(), end.date.getMonth(), end.date.getDate() + 1);
    if (now >= dayAfterEnd) return null; // over
    const endText = end.monthOnly ? monthFmt.format(end.date) : dayFmt.format(end.date);
    if (!item.start) return { tag: "On now", when: `Until ${endText}` }; // running, start date unknown
    const start = parseDay(item.start);
    if (!start) return null;
    if (start.date - now > EVENT_LOOKAHEAD_DAYS * 86_400_000) return null; // too far off
    const startText = dayFmt.format(start.date);
    const oneDay = !item.end || item.end === item.start;
    return { tag: start.date <= now ? "On now" : "Coming up", when: oneDay ? startText : `${startText} to ${endText}` };
  }
  const opened = parseDay(item.opened);
  if (!opened) return null;
  if (opened.date > now) return { tag: "Opening soon", when: `Opens ${monthFmt.format(opened.date)}` };
  const cutoff = new Date(now.getFullYear(), now.getMonth() - NEW_PLACE_MONTHS, now.getDate());
  if (opened.date < cutoff) return null; // no longer new
  return { tag: "New", when: `Opened ${monthFmt.format(opened.date)}` };
}

function placeItem({ name, meta, note, tag, source, place }) {
  const selected = state.jb === CUSTOM && state.custom?.name === name;
  const pick = el(
    "button",
    { type: "button", className: "place-pick" },
    el("span", { className: "place-name", textContent: name }),
    el("span", { className: "place-meta" }, tag ? el("span", { className: "place-tag", textContent: tag }) : null, meta),
    note ? el("span", { className: "place-note", textContent: note }) : null
  );
  pick.setAttribute("aria-pressed", String(selected));
  pick.addEventListener("click", () => setCustomDestination(place));
  return el(
    "li",
    { className: selected ? "place selected" : "place" },
    pick,
    source ? el("a", { className: "place-source", href: source, target: "_blank", rel: "noopener", textContent: "Source" }) : null
  );
}

function renderCurated() {
  const list = $("#curated");
  const items = state.curated
    .map((item) => ({ item, status: curatedStatus(item) }))
    .filter(({ item, status }) => status && Number.isFinite(item.lat) && Number.isFinite(item.lng));
  if (items.length === 0) {
    list.replaceChildren(el("li", { className: "places-empty", textContent: "Nothing listed right now." }));
    return;
  }
  list.replaceChildren(
    ...items.map(({ item, status }) =>
      placeItem({
        name: item.name,
        tag: status.tag,
        meta: [item.category, item.area, status.when].filter(Boolean).join(" · "),
        note: item.note,
        source: /^https:\/\//.test(item.source ?? "") ? item.source : null,
        place: { name: item.name, lat: item.lat, lng: item.lng },
      })
    )
  );
}

// All OpenStreetMap searches go through one queue that keeps them at least
// NOMINATIM_GAP_MS apart, however quickly the destination is changed.
let nominatimQueue = Promise.resolve();
let nominatimLast = 0;

function nominatim(url) {
  const result = nominatimQueue.then(async () => {
    const wait = nominatimLast + NOMINATIM_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    nominatimLast = Date.now();
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  });
  nominatimQueue = result.catch(() => {});
  return result;
}

const nearbyCache = new Map(); // anchor key -> items
let nearbyRun = 0;
let nearbyTimer = 0;

// The point the nearby list is centred on. A place picked from "Where to go"
// keeps the list where it is, so it does not jump under the user's finger.
function nearbyAnchor() {
  if (state.jb === CUSTOM) {
    return state.nearby.anchor ?? { lat: state.custom.lat, lng: state.custom.lng, title: `Near ${state.custom.name}` };
  }
  const p = pointFor("jb");
  if (!p) return null;
  return { lat: p.lat, lng: p.lng, title: state.jb === GPS ? "Near you" : `Near ${JB_PLACES[state.jb][0]}` };
}

function updateNearby() {
  const anchor = nearbyAnchor();
  if (!anchor) {
    nearbyRun += 1;
    clearTimeout(nearbyTimer);
    state.nearby = { status: "waiting", title: "Near you", items: [], key: null, anchor: null };
    renderNearby();
    return;
  }
  const key = `${anchor.lat.toFixed(3)},${anchor.lng.toFixed(3)}`;
  if (key === state.nearby.key) {
    renderNearby(); // same place: only the selection highlight may have changed
    return;
  }
  nearbyRun += 1;
  clearTimeout(nearbyTimer);
  const cached = nearbyCache.get(key);
  state.nearby = { status: cached ? "done" : "loading", title: anchor.title, items: cached ?? [], key, anchor };
  renderNearby();
  if (!cached) nearbyTimer = setTimeout(() => loadNearby(anchor, key), NEARBY_DEBOUNCE_MS);
}

async function loadNearby(anchor, key) {
  const run = ++nearbyRun;
  const d = NEARBY_BOX_DEG;
  const box = [anchor.lng - d, anchor.lat + d, anchor.lng + d, anchor.lat - d].map((n) => n.toFixed(4)).join(",");
  const seen = new Set();
  const found = [];
  let failed = 0;
  for (const q of NEARBY_QUERIES) {
    try {
      const url = `${NOMINATIM}?format=jsonv2&limit=15&bounded=1&accept-language=en&viewbox=${box}&q=${encodeURIComponent(q)}`;
      const rows = await nominatim(url);
      if (run !== nearbyRun) return;
      for (const r of rows) {
        // The same mall is often mapped twice (building and grounds), so match on name.
        const name = String(r.name ?? "").trim();
        const place = { name, lat: Number(r.lat), lng: Number(r.lon) };
        if (!name || seen.has(name.toLowerCase()) || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) continue;
        seen.add(name.toLowerCase());
        found.push({ place, type: String(r.type ?? "").replace(/_/g, " "), km: kmBetween(anchor, place) });
      }
    } catch {
      if (run !== nearbyRun) return;
      failed += 1;
    }
    found.sort((a, b) => a.km - b.km);
    state.nearby = { ...state.nearby, items: found.slice(0, NEARBY_MAX) };
    renderNearby();
  }
  const items = found.slice(0, NEARBY_MAX);
  const allFailed = failed === NEARBY_QUERIES.length;
  if (failed === 0) nearbyCache.set(key, items);
  // After a total failure the key is dropped so the next change tries again.
  state.nearby = { ...state.nearby, status: allFailed ? "error" : "done", items, key: allFailed ? null : key };
  renderNearby();
}

function renderNearby() {
  const { status, title, items } = state.nearby;
  $("#nearby-title").textContent = title || "Nearby";
  const rows = items.map(({ place, type, km }) =>
    placeItem({
      name: place.name,
      meta: `${type.charAt(0).toUpperCase()}${type.slice(1)} · ${km < 0.1 ? "here" : `${km.toFixed(1)} km away`}`,
      place,
    })
  );
  if (rows.length === 0) {
    const text = {
      error: "Nearby places could not be loaded.",
      done: "No malls or attractions found nearby.",
      waiting: "Waiting for your location…",
    }[status];
    rows.push(el("li", { className: "places-empty", textContent: text ?? "Looking for places nearby…" }));
  }
  $("#nearby").replaceChildren(...rows);
}

function setCustomDestination(place) {
  state.custom = place;
  state.jb = CUSTOM;
  refresh();
  $("#verdict").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------- form ----------

function renderForm() {
  for (const btn of document.querySelectorAll(".segmented button")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.dir === state.dir));
  }
  const jbSelect = $("#jb");
  jbSelect.querySelector(`option[value="${CUSTOM}"]`)?.remove();
  if (state.jb === CUSTOM && state.custom) {
    jbSelect.prepend(el("option", { value: CUSTOM, textContent: state.custom.name }));
  }
  $("#sg").value = state.sg;
  jbSelect.value = state.jb;
}

function fillSelect(select, places) {
  select.append(el("option", { value: GPS, textContent: "My current location" }));
  for (const [id, [name]] of Object.entries(places)) {
    select.append(el("option", { value: id, textContent: name }));
  }
}

// The one place every change of trip goes through: settles where the GPS
// position belongs, then redraws and reloads whatever depends on the trip.
function refresh() {
  correctGpsSide();
  save();
  renderForm();
  renderCurated();
  if (gpsSide() && gpsStale()) requestGps();
  updateRoutes();
  updateNearby();
}

function onPlaceChange(side) {
  const other = side === "sg" ? "jb" : "sg";
  const value = $(`#${side}`).value;
  if (value === CUSTOM) return;
  state[side] = value;
  if (value !== GPS) state.home[side] = value;
  if (side === "jb") state.custom = null;
  // Only one end can be "my current location".
  if (value === GPS && state[other] === GPS) state[other] = state.home[other];
  setGpsStatus(null);
  refresh();
}

function init() {
  loadSaved();
  fillSelect($("#sg"), SG_PLACES);
  fillSelect($("#jb"), JB_PLACES);
  buildCards();

  for (const btn of document.querySelectorAll(".segmented button")) {
    btn.addEventListener("click", () => {
      if (state.dir === btn.dataset.dir) return;
      state.dir = btn.dataset.dir;
      refresh();
    });
  }
  $("#sg").addEventListener("change", () => onPlaceChange("sg"));
  $("#jb").addEventListener("change", () => onPlaceChange("jb"));

  refresh();
  loadCurated();

  updateCameras();
  setInterval(() => {
    if (!document.hidden) updateCameras();
  }, CAMERA_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    updateCameras();
    if (gpsSide() && gpsStale()) requestGps();
  });
}

init();
