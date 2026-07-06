#!/usr/bin/env node
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

const port = process.env.PORT || 3999;
const base = `http://127.0.0.1:${port}`;
const APP_PASSWORD = process.env.APP_PASSWORD || 'lifely2026';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update(`${APP_PASSWORD}|ll-demand-planner-session-v1`).digest('hex');
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
function token() {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + SESSION_TTL_MS, nonce: crypto.randomBytes(12).toString('hex') })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
const session = token();
let snapshot = {};
try { snapshot = JSON.parse(fs.readFileSync('data/cache-snapshot.json', 'utf8')); } catch (_) {}
const bomMasters = new Set(Object.keys(snapshot.cin7BOMs || {}).map(s => String(s).toUpperCase()));
function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { headers: { 'x-session': session } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`${path} HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}
(async () => {
  const list = await get('/api/ck-list');
  const ids = list.list.map(row => row.id);
  const little = ids.filter(id => id.startsWith('ll'));
  const rows = [];
  for (const id of ids) {
    const data = await get(`/api/ck/${encodeURIComponent(id)}`);
    const visible = [...new Set([...Object.keys(data.cin7 || {}), ...Object.keys(data.velocity || {})])].filter(s => s && !s.startsWith('_'));
    const setRows = visible.filter(s => /-SET(?:-|$)/.test(s));
    const bomRows = visible.filter(s => bomMasters.has(String(s).toUpperCase()) || data.bomData?._components?.[s] || data.reorderBomData?._components?.[s]);
    const hasBomData = !!data.bomData;
    rows.push({ id, name: data.ck?.name || id, visible: visible.length, setRows, bomRows, hasBomData });
  }
  console.log('Little Lifely visible -SET rows:');
  for (const r of rows.filter(r => little.includes(r.id))) {
    console.log(`${r.id}, visible=${r.visible}, setRows=${r.setRows.length}${r.hasBomData ? ', hasBomData' : ''}`);
    if (r.setRows.length) console.log('  ' + r.setRows.slice(0, 30).join(', ') + (r.setRows.length > 30 ? ` ... +${r.setRows.length - 30}` : ''));
  }
  console.log('\nAll tabs visible -SET rows:');
  for (const r of rows.filter(r => r.setRows.length)) {
    console.log(`${r.id}, ${r.setRows.length}: ${r.setRows.slice(0, 20).join(', ')}${r.setRows.length > 20 ? ` ... +${r.setRows.length - 20}` : ''}`);
  }
  console.log('\nVisible Cin7 BOM master rows / BOM data rows:');
  for (const r of rows.filter(r => r.bomRows.length || r.hasBomData)) {
    console.log(`${r.id}, bomRows=${r.bomRows.length}, hasBomData=${r.hasBomData}`);
    if (r.bomRows.length) console.log('  ' + r.bomRows.slice(0, 30).join(', ') + (r.bomRows.length > 30 ? ` ... +${r.bomRows.length - 30}` : ''));
  }
})().catch(err => { console.error(err); process.exit(1); });
