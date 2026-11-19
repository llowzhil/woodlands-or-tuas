// Spike: can Google Routes be forced through each checkpoint, and does its
// traffic-aware time reflect the checkpoint queue?
//
// Usage:  node spike/routes-test.mjs            (SG -> JB)
//         node spike/routes-test.mjs --reverse  (JB -> SG)
// Needs GOOGLE_MAPS_API_KEY in .env (Routes API enabled on the key's project).

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const KEY = process.env.GOOGLE_MAPS_API_KEY;
if (!KEY) {
  console.error("Missing GOOGLE_MAPS_API_KEY. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const reverse = process.argv.includes("--reverse");

// One pass-through point per carriageway on each bridge, plus the compass
// heading of the JB-bound side, so a route is pinned to the side that matches
// the direction of travel. (Without this, OSRM made JB -> SG routes about
// 10 km too long.) Not yet run against Google: check the distances look sane.
const CHECKPOINTS = {
  Woodlands: {
    headingToJB: 345,
    toJB: { lat: 1.452723, lng: 103.76907 },
    toSG: { lat: 1.452765, lng: 103.769211 },
  },
  Tuas: {
    headingToJB: 306,
    toJB: { lat: 1.351351, lng: 103.632254 },
    toSG: { lat: 1.351442, lng: 103.632333 },
  },
};

const SG = {
  Sengkang: { lat: 1.3917, lng: 103.895 },
  "Jurong East": { lat: 1.3331, lng: 103.7423 },
  Bedok: { lat: 1.324, lng: 103.93 },
  Orchard: { lat: 1.304, lng: 103.832 },
};

const JB = {
  "City Square": { lat: 1.4625, lng: 103.764 },
  "Mid Valley Southkey": { lat: 1.501, lng: 103.777 },
  "AEON Bukit Indah": { lat: 1.481, lng: 103.656 },
  Legoland: { lat: 1.427, lng: 103.631 },
};

const wp = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
const secs = (s) => (s ? parseInt(s, 10) : NaN);
const mins = (s) => Math.round(s / 60);

function viaPoint(cp) {
  const p = reverse ? cp.toSG : cp.toJB;
  const heading = reverse ? (cp.headingToJB + 180) % 360 : cp.headingToJB;
  return { via: true, location: { latLng: { latitude: p.lat, longitude: p.lng }, heading } };
}

async function route(from, to, cp) {
  const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": KEY,
      "X-Goog-FieldMask":
        "routes.duration,routes.staticDuration,routes.distanceMeters,routes.warnings",
    },
    body: JSON.stringify({
      origin: wp(from),
      destination: wp(to),
      intermediates: [viaPoint(cp)],
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE_OPTIMAL",
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json.error ?? json)}`);
  const r = json.routes?.[0];
  if (!r) throw new Error("no route returned");
  return {
    live: secs(r.duration),
    free: secs(r.staticDuration),
    km: r.distanceMeters / 1000,
    warnings: r.warnings ?? [],
  };
}

console.log(`Direction: ${reverse ? "JB -> SG" : "SG -> JB"}   at ${new Date().toString()}\n`);
console.log(
  ["SG point", "JB point", "via", "km", "no-traffic", "live", "delay", "verdict"]
    .map((h, i) => h.padEnd([12, 20, 10, 6, 11, 6, 6, 0][i]))
    .join(" ")
);

for (const [sgName, sg] of Object.entries(SG)) {
  for (const [jbName, jb] of Object.entries(JB)) {
    const [from, to] = reverse ? [jb, sg] : [sg, jb];
    const results = {};
    for (const [cpName, cp] of Object.entries(CHECKPOINTS)) {
      try {
        results[cpName] = await route(from, to, cp);
      } catch (e) {
        results[cpName] = { error: e.message };
      }
    }
    const ok = Object.values(results).every((r) => !r.error);
    const diff = ok ? mins(results.Woodlands.live - results.Tuas.live) : null;
    const verdict = !ok
      ? ""
      : Math.abs(diff) < 10
        ? `too close (${Math.abs(diff)} min)`
        : diff > 0
          ? `Tuas by ${diff} min`
          : `Woodlands by ${-diff} min`;
    for (const [cpName, r] of Object.entries(results)) {
      if (r.error) {
        console.log(`${sgName.padEnd(12)} ${jbName.padEnd(20)} ${cpName.padEnd(10)} ERROR ${r.error}`);
        continue;
      }
      console.log(
        [
          sgName.padEnd(12),
          jbName.padEnd(20),
          cpName.padEnd(10),
          r.km.toFixed(1).padEnd(6),
          `${mins(r.free)} min`.padEnd(11),
          `${mins(r.live)}`.padEnd(6),
          `+${mins(r.live - r.free)}`.padEnd(6),
          cpName === "Woodlands" ? verdict : "",
        ].join(" ") + (r.warnings.length ? `  ! ${r.warnings.join("; ")}` : "")
      );
    }
  }
}
