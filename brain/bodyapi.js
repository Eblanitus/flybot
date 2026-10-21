// Клиент HTTP API тела (FlyBot/FlyBot_01). Только встроенные модули Node.
// Используется и исполнителем (runner.js), и дочерним процессом навыка (worker.js).
'use strict';
const http = require('http');

const DEFAULT_URL = 'http://127.0.0.1:3199';

// Низкоуровневый запрос. Без собственного тайм-аута: wait:true и /wait могут идти долго,
// навык убивается снаружи (по timeout_sec) вместе со своими сокетами.
function request(baseUrl, method, path, body) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(path, baseUrl); } catch (e) { return reject(new Error('плохой адрес тела: ' + baseUrl)); }
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
      agent: false
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch (e) {
          return reject(new Error(`тело ответило не JSON (HTTP ${res.statusCode}): ${text.slice(0, 200)}`));
        }
        resolve({ status: res.statusCode, json });
      });
      res.on('error', reject);
    });
    req.on('error', e => reject(new Error(`тело недоступно (${baseUrl}): ${e.code || e.message}`)));
    if (data) req.write(data);
    req.end();
  });
}

const get = (baseUrl, path) => request(baseUrl, 'GET', path).then(r => r.json);
const post = (baseUrl, path, body) => request(baseUrl, 'POST', path, body).then(r => r.json);

module.exports = { DEFAULT_URL, request, get, post };
