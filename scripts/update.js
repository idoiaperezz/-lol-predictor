// Actualización diaria: descarga los CSV de Oracle's Elixir desde Google Drive,
// entrena el modelo y deja la web lista en ./site. Lo ejecuta GitHub Actions.
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");
const Papa = require("papaparse");
const { compactRow, trainAndEvaluate } = require("../model.js");

const ROOT = path.join(__dirname, "..");
const CACHE = path.join(ROOT, "cache");            // persiste entre ejecuciones (actions/cache)
const SITE = path.join(ROOT, "site");              // lo que se publica en GitHub Pages
const FOLDER = process.env.DRIVE_FOLDER_ID || "1gLSw0RLjBbtaNy0dgnGQDAZOHIgCe-HH";
const KEY = process.env.DRIVE_API_KEY || "";
const TZ = process.env.TIMEZONE || "Europe/Madrid";
const MIN_YEAR = +(process.env.MIN_YEAR || 2020);
const FORCE = process.env.FORCE === "1";
const DEPLOY_ONLY = process.env.DEPLOY_ONLY === "1";
const LOCAL_DIR = process.env.LOCAL_CSV_DIR || "";  // solo para pruebas sin Drive
const API = "https://www.googleapis.com/drive/v3/files";

const statePath = path.join(CACHE, "state.json");
const modelPath = path.join(CACHE, "model.json");
const rowsPath = y => path.join(CACHE, `rows-${y}.json.gz`);
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const output = (k, v) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };

class QuotaError extends Error {}

async function driveFail(r) {
  let msg = "", reason = "";
  try { const e = (await r.json()).error || {}; msg = e.message || ""; reason = e.errors?.[0]?.reason || ""; } catch {}
  if (reason === "downloadQuotaExceeded" || /quota for this file/i.test(msg)) return new QuotaError(msg);
  return new Error(`Google Drive ${r.status}: ${msg}`);
}

async function listCsvs() {
  if (LOCAL_DIR) {
    return fs.readdirSync(LOCAL_DIR).filter(n => /\.csv$/i.test(n)).map(n => ({
      id: n, name: n, modifiedTime: fs.statSync(path.join(LOCAL_DIR, n)).mtime.toISOString(),
    }));
  }
  if (!KEY) throw new Error("Falta el secreto DRIVE_API_KEY en el repositorio.");
  const q = encodeURIComponent(`'${FOLDER}' in parents and trashed=false`);
  const r = await fetch(`${API}?q=${q}&pageSize=200&fields=files(id,name,modifiedTime,size)` +
    `&supportsAllDrives=true&includeItemsFromAllDrives=true&key=${encodeURIComponent(KEY)}`);
  if (!r.ok) throw await driveFail(r);
  return ((await r.json()).files || []).filter(f => /\.csv$/i.test(f.name));
}

async function download(f, dest) {
  if (LOCAL_DIR) return fs.copyFileSync(path.join(LOCAL_DIR, f.id), dest);
  const r = await fetch(`${API}/${f.id}?alt=media&supportsAllDrives=true&key=${encodeURIComponent(KEY)}`);
  if (!r.ok) throw await driveFail(r);
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
}

function parseCsv(file) {
  return new Promise((resolve, reject) => {
    const out = [];
    Papa.parse(fs.createReadStream(file), {
      header: true, skipEmptyLines: true,
      step: res => { const c = compactRow(res.data); if (c) out.push(c); },
      complete: () => resolve(out), error: reject,
    });
  });
}

// Números más cortos para que model.json pese menos
const slim = (k, v) => (typeof v === "number" && !Number.isInteger(v) ? +v.toPrecision(6) : v);

function buildSite() {
  fs.rmSync(SITE, { recursive: true, force: true });
  fs.mkdirSync(path.join(SITE, "data"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "index.html"), path.join(SITE, "index.html"));
  fs.copyFileSync(path.join(ROOT, "model.js"), path.join(SITE, "model.js"));
  fs.copyFileSync(modelPath, path.join(SITE, "data", "model.json"));
  fs.writeFileSync(path.join(SITE, ".nojekyll"), "");
}

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  const state = readJSON(statePath, { files: {} });
  const haveModel = fs.existsSync(modelPath);

  if (DEPLOY_ONLY && haveModel) { buildSite(); output("deploy", "true"); console.log("Solo republicar la página."); return; }
  if (!FORCE && haveModel && state.day === today()) { console.log(`Ya actualizado hoy (${state.day}). Nada que hacer.`); output("deploy", "false"); return; }

  const files = (await listCsvs())
    .map(f => ({ ...f, year: +((f.name.match(/^(\d{4})/) || [])[1] || 0) }))
    .filter(f => f.year >= MIN_YEAR)
    .sort((a, b) => a.year - b.year || (a.modifiedTime < b.modifiedTime ? -1 : 1));
  if (!files.length) throw new Error(`No hay CSV de ${MIN_YEAR} en adelante en la carpeta.`);
  const byYear = new Map(files.map(f => [f.year, f]));   // si hay dos del mismo año, el más reciente

  let changed = !haveModel || FORCE || !!state.dirty;
  for (const [year, f] of byYear) {
    const prev = state.files[year];
    if (!FORCE && prev && prev.modifiedTime === f.modifiedTime && fs.existsSync(rowsPath(year))) continue;
    console.log(`Descargando ${f.name}…`);
    const tmp = path.join(CACHE, "tmp.csv");
    try {
      await download(f, tmp);
      const rows = await parseCsv(tmp);
      if (!rows.length) throw new Error(`${f.name} no tiene filas de equipo.`);
      fs.writeFileSync(rowsPath(year), zlib.gzipSync(JSON.stringify(rows)));
      console.log(`  ${rows.length} filas de equipo.`);
    } finally { fs.rmSync(tmp, { force: true }); }
    state.files[year] = { id: f.id, name: f.name, modifiedTime: f.modifiedTime };
    state.dirty = true;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 1));   // guarda el progreso parcial
    changed = true;
  }

  if (changed) {
    const byKey = new Map();
    for (const year of byYear.keys()) {
      for (const r of JSON.parse(zlib.gunzipSync(fs.readFileSync(rowsPath(year))))) byKey.set(r.g + "|" + r.s, r);
    }
    console.log(`Entrenando con ${byKey.size} filas…`);
    const M = trainAndEvaluate([...byKey.values()]);
    const recent = M.tMax - 400 * 864e5;
    const teams = [...M.teams.values()].filter(t => t.n >= 5 && t.last >= recent);
    const latest = byYear.get(Math.max(...byYear.keys()));
    fs.writeFileSync(modelPath, JSON.stringify({
      updated: new Date().toISOString(), source: { name: latest.name, modifiedTime: latest.modifiedTime },
      nGames: M.nGames, tMin: M.tMin, tMax: M.tMax, model: M.model, eval: M.eval, teams,
    }, slim));
    console.log(`Modelo listo: ${M.nGames} partidas, ${teams.length} equipos activos.`);
    fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "data", "ultima-actualizacion.txt"),
      `${new Date().toISOString()}\n${latest.name}\n${M.nGames} partidas\n`);
  } else {
    console.log("El CSV no ha cambiado desde la última vez.");
  }

  state.day = today();
  delete state.dirty;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
  buildSite();
  output("deploy", changed ? "true" : "false");
  output("commit", changed ? "true" : "false");
}

main().catch(e => {
  if (e instanceof QuotaError) {
    // No es un fallo nuestro: Google limita las descargas del archivo. Se reintenta en la próxima hora.
    console.log("::warning::Google ha limitado temporalmente las descargas del CSV. Se reintentará en la próxima ejecución.");
    output("deploy", "false");
    return;
  }
  console.error(e);
  process.exit(1);
});
