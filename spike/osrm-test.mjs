// Spike: keyless routing through each checkpoint with the public OSRM demo server.
// OSRM has no live traffic, so these are free-flow drive times only.
//
// Usage:  node spike/osrm-test.mjs            (SG -> JB)
//         node spike/osrm-test.mjs --reverse  (JB -> SG)

const reverse = process.argv.includes("--reverse");
const BASE = process.env.OSRM_BASE ?? "https://router.project-osrm.org";

// Pass-through points on each bridge. `toJB` is the compass bearing of the
// JB-bound carriageway; it makes the router snap to the correct side of the
// bridge. Without it, JB -> SG routes snap to the JB-bound side and come out
// about 10 km too long.
const CHECKPOINTS = {
  Woodlands: { lat: 1.4527, lng: 103.769, toJB: 345 },
  Tuas: { lat: 1.351, lng: 103.632, toJB: 306 },
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

const ll = (p) => `${p.lng},${p.lat}`;
const mins = (s) => Math.round(s / 60);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function route(from, to, via) {
  const bearing = reverse ? (via.toJB + 180) % 360 : via.toJB;
  const url =
    `${BASE}/route/v1/driving/${ll(from)};${ll(via)};${ll(to)}` +
    `?overview=false&continue_straight=true&bearings=;${bearing},45;&radiuses=;200;`;
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok || json.code !== "Ok") throw new Error(`${res.status} ${json.code} ${json.message ?? ""}`);
  const r = json.routes[0];
  return {
    secs: r.duration,
    km: r.distance / 1000,
    snap: json.waypoints[1].distance, // metres from our bridge point to the road it snapped to
  };
}

console.log(`Direction: ${reverse ? "JB -> SG" : "SG -> JB"}   (free-flow, no traffic)\n`);
console.log(
  ["SG point", "JB point", "via", "km", "drive", "snap m", "verdict"]
    .map((h, i) => h.padEnd([12, 20, 10, 6, 8, 7, 0][i]))
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
      await sleep(1100); // demo server: stay around 1 request per second
    }
    const ok = Object.values(results).every((r) => !r.error);
    const diff = ok ? mins(results.Woodlands.secs - results.Tuas.secs) : null;
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
          `${mins(r.secs)} min`.padEnd(8),
          r.snap.toFixed(0).padEnd(7),
          cpName === "Woodlands" ? verdict : "",
        ].join(" ")
      );
    }
  }
}
