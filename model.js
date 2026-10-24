// Núcleo del modelo. Lo usan la página (navegador) y scripts/update.js (Node).
// ===== Núcleo del modelo: procesado, Elo, medias móviles, regresión logística =====
const INTL = new Set(["WLDs", "MSI", "EWC", "FST", "Worlds", "MSC"]);
const SPAN = 10, ALPHA = 2 / (SPAN + 1);
const ELO0 = 1500, K = 24, MIN_GAMES = 5;

// clave, columna (o null si es calculada), escala para el modelo
const STATS = [
  ["wr", "result", 1],
  ["gd15", "golddiffat15", 1000],
  ["xpd15", "xpdiffat15", 1000],
  ["csd15", "csdiffat15", 10],
  ["fd", "firstdragon", 1],
  ["ft", "firsttower", 1],
  ["fh", "firstherald", 1],
  ["fb", "firstbaron", 1],
  ["kpm", null, 1],
  ["dpm", null, 1],
];
const FEATURES = ["elo", ...STATS.map(s => s[0]), "sidewr"];

function num(v) {
  if (v === "" || v === null || v === undefined) return NaN;
  const n = +v;
  return Number.isFinite(n) ? n : NaN;
}

// Fila CSV de Oracle's Elixir -> fila compacta (o null si no es fila de equipo)
function compactRow(r) {
  if (r.position !== "team") return null;
  const team = r.teamname || r.teamid;
  const side = r.side === "Blue" ? 0 : r.side === "Red" ? 1 : -1;
  const res = num(r.result);
  if (!team || side < 0 || !(res === 0 || res === 1) || !r.gameid) return null;
  const t = Date.parse(String(r.date).replace(" ", "T") + "Z");
  if (!Number.isFinite(t)) return null;
  const len = num(r.gamelength);
  const mins = len > 0 ? len / 60 : NaN;
  const o = {
    g: r.gameid, t, lg: r.league || "", s: side, tm: team, res,
    gd15: num(r.golddiffat15), xpd15: num(r.xpdiffat15), csd15: num(r.csdiffat15),
    fd: num(r.firstdragon), ft: num(r.firsttower), fh: num(r.firstherald), fb: num(r.firstbaron),
    kpm: num(r.kills) / mins, dpm: num(r.deaths) / mins,
  };
  o.wr = res;
  return o;
}

function ewmPush(e, x) {
  if (!Number.isFinite(x)) return;
  e.n = (1 - ALPHA) * e.n + x;
  e.d = (1 - ALPHA) * e.d + 1;
  e.c++;
}
const ewmMean = e => (e.c >= 3 ? e.n / e.d : NaN);
const newEwm = () => ({ n: 0, d: 0, c: 0 });

function newTeam(name) {
  const s = { name, elo: ELO0, year: null, n: 0, last: 0, lg: "", lgIntl: "", e: {}, side: [newEwm(), newEwm()] };
  for (const [k] of STATS) s.e[k] = newEwm();
  return s;
}

// Valores "legibles" de un equipo jugando en un lado concreto
function teamValues(T, side) {
  const v = { elo: T.elo };
  for (const [k] of STATS) v[k] = ewmMean(T.e[k]);
  v.sidewr = ewmMean(T.side[side]);
  return v;
}

// Vector de diferencias azul - rojo, escalado
function featVec(B, R) {
  const a = teamValues(B, 0), b = teamValues(R, 1);
  const x = [(a.elo - b.elo) / 100];
  for (const [k, , sc] of STATS) {
    x.push(Number.isFinite(a[k]) && Number.isFinite(b[k]) ? (a[k] - b[k]) / sc : 0);
  }
  x.push(Number.isFinite(a.sidewr) && Number.isFinite(b.sidewr) ? a.sidewr - b.sidewr : 0);
  return x;
}

function seasonReset(T, year) {
  if (T.year !== null && T.year !== year) T.elo = ELO0 + 0.75 * (T.elo - ELO0);
  T.year = year;
}

// Recorre todas las partidas en orden y genera el dataset + el estado final de cada equipo
function processGames(rows) {
  const games = new Map();
  for (const r of rows) {
    let g = games.get(r.g);
    if (!g) { g = { id: r.g, t: r.t, lg: r.lg, b: null, r: null }; games.set(r.g, g); }
    if (r.s === 0) g.b = r; else g.r = r;
  }
  const list = [...games.values()]
    .filter(g => g.b && g.r && g.b.tm !== g.r.tm && g.b.res + g.r.res === 1)
    .sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));

  const teams = new Map();
  const get = n => { let s = teams.get(n); if (!s) { s = newTeam(n); teams.set(n, s); } return s; };
  const X = [], Y = [], T = [], ELO = [];

  for (const g of list) {
    const A = get(g.b.tm), B = get(g.r.tm);
    const year = new Date(g.t).getUTCFullYear();
    seasonReset(A, year); seasonReset(B, year);

    if (A.n >= MIN_GAMES && B.n >= MIN_GAMES) {
      X.push(featVec(A, B)); Y.push(g.b.res); T.push(g.t); ELO.push(A.elo - B.elo);
    }
    // Elo
    const ea = 1 / (1 + Math.pow(10, (B.elo - A.elo) / 400));
    const k = K * (INTL.has(g.lg) ? 1.5 : 1);
    A.elo += k * (g.b.res - ea);
    B.elo -= k * (g.b.res - ea);
    // medias móviles
    for (const [S, row, side] of [[A, g.b, 0], [B, g.r, 1]]) {
      for (const [key] of STATS) ewmPush(S.e[key], row[key]);
      ewmPush(S.side[side], row.res);
      S.n++; S.last = g.t;
      if (INTL.has(g.lg)) S.lgIntl = g.lg; else S.lg = g.lg;
    }
  }
  return { X, Y, T, ELO, teams, nGames: list.length, tMin: list.length ? list[0].t : 0, tMax: list.length ? list[list.length - 1].t : 0 };
}

// ---------- regresión logística con L2 (IRLS / Newton) ----------
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

const sigmoid = z => 1 / (1 + Math.exp(-z));

function fitLogistic(X, Y, lambda = 2) {
  const n = X.length, d = X[0].length;
  const mu = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const x of X) for (let j = 0; j < d; j++) mu[j] += x[j] / n;
  for (const x of X) for (let j = 0; j < d; j++) sd[j] += (x[j] - mu[j]) ** 2 / n;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const Z = X.map(x => [1, ...x.map((v, j) => (v - mu[j]) / sd[j])]);
  const D = d + 1;
  let w = new Array(D).fill(0);
  for (let it = 0; it < 30; it++) {
    const g = new Array(D).fill(0), H = Array.from({ length: D }, () => new Array(D).fill(0));
    for (let i = 0; i < n; i++) {
      const z = Z[i];
      let s = 0; for (let j = 0; j < D; j++) s += w[j] * z[j];
      const p = sigmoid(s), r = Y[i] - p, q = p * (1 - p);
      for (let j = 0; j < D; j++) {
        g[j] += r * z[j];
        const qz = q * z[j];
        for (let k = j; k < D; k++) H[j][k] += qz * z[k];
      }
    }
    for (let j = 0; j < D; j++) for (let k = 0; k < j; k++) H[j][k] = H[k][j];
    for (let j = 1; j < D; j++) { g[j] -= lambda * w[j]; H[j][j] += lambda; }
    const step = solve(H, g);
    let mx = 0;
    w = w.map((v, j) => { mx = Math.max(mx, Math.abs(step[j])); return v + step[j]; });
    if (mx < 1e-7) break;
  }
  return { w, mu, sd };
}

function modelLogit(m, x) {
  let s = m.w[0];
  for (let j = 0; j < x.length; j++) s += m.w[j + 1] * (x[j] - m.mu[j]) / m.sd[j];
  return s;
}

function metrics(Y, P) {
  let ll = 0, br = 0, acc = 0;
  for (let i = 0; i < Y.length; i++) {
    const p = Math.min(Math.max(P[i], 1e-6), 1 - 1e-6);
    ll -= Y[i] * Math.log(p) + (1 - Y[i]) * Math.log(1 - p);
    br += (P[i] - Y[i]) ** 2;
    acc += (P[i] > 0.5) === (Y[i] === 1) ? 1 : 0;
  }
  const n = Y.length;
  return { logloss: ll / n, brier: br / n, acc: acc / n };
}

function trainAndEvaluate(rows) {
  const D = processGames(rows);
  if (D.X.length < 200) throw new Error("Hay muy pocas partidas para entrenar (" + D.X.length + "). Sube más datos.");
  const idx = D.T.map((t, i) => i);
  const cut = Math.floor(idx.length * 0.8);
  const trX = D.X.slice(0, cut), trY = D.Y.slice(0, cut);
  const teX = D.X.slice(cut), teY = D.Y.slice(cut);

  const m = fitLogistic(trX, trY);
  const blueRate = trY.reduce((a, b) => a + b, 0) / trY.length;
  const eval_ = {
    from: D.T[cut], nTrain: trX.length, nTest: teX.length,
    model: metrics(teY, teX.map(x => sigmoid(modelLogit(m, x)))),
    elo: metrics(teY, D.ELO.slice(cut).map(d => 1 / (1 + Math.pow(10, -d / 400)))),
    blue: metrics(teY, teY.map(() => blueRate)),
    blueRate,
  };
  const final = fitLogistic(D.X, D.Y);
  return { model: final, eval: eval_, teams: D.teams, nGames: D.nGames, tMin: D.tMin, tMax: D.tMax };
}

// Probabilidad de que gane el equipo en lado azul
function pBlue(M, blueName, redName) {
  const B = M.teams.get(blueName), R = M.teams.get(redName);
  return sigmoid(modelLogit(M.model, featVec(B, R)));
}

// Contribución de cada feature al logit (positivo = favorece al azul)
function contributions(M, blueName, redName) {
  const x = featVec(M.teams.get(blueName), M.teams.get(redName));
  return FEATURES.map((f, j) => ({ f, c: M.model.w[j + 1] * (x[j] - M.model.mu[j]) / M.model.sd[j] }));
}

// Probabilidad de que X (azul en el game 1) gane la serie.
// Desde el game 2, el perdedor elige lado y se asume que elige azul.
function seriesProb(M, X, Y, bo) {
  const need = Math.floor(bo / 2) + 1;
  const pXb = pBlue(M, X, Y), pXr = 1 - pBlue(M, Y, X);
  const memo = new Map();
  const f = (a, b, xBlue) => {
    if (a === need) return 1;
    if (b === need) return 0;
    const key = a + "," + b + "," + xBlue;
    if (memo.has(key)) return memo.get(key);
    const p = xBlue ? pXb : pXr;
    const v = p * f(a + 1, b, false) + (1 - p) * f(a, b + 1, true);
    memo.set(key, v);
    return v;
  };
  return f(0, 0, true);
}

if (typeof module !== "undefined") module.exports = { compactRow, trainAndEvaluate, pBlue, seriesProb, contributions, teamValues, FEATURES };
