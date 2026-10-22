// Дочерний процесс исполнителя: проверяет или запускает ОДИН выученный навык.
// Запускается из runner.js через child_process.fork; сам по себе не запускать.
// Файл навыка читается заново при каждом запуске — поэтому правки подхватываются без перезапуска исполнителя.
'use strict';
const path = require('path');
const bodyapi = require('./bodyapi');

const MAX_DEPTH = 3;       // глубина вложенных skill()
const STACK_LINES = 15;    // сколько строк стека показывать мозгу

if (typeof process.send !== 'function') {
  console.error('worker.js запускается только из runner.js (fork)');
  process.exit(2);
}
const send = m => { try { process.send(m); } catch (e) {} };

// ---------- Ошибка -> понятный текст со стеком ----------
function fmtError(e) {
  if (e === null || e === undefined) return 'неизвестная ошибка';
  if (typeof e !== 'object') return String(e);
  let text = e.stack ? String(e.stack) : String(e.message || e);
  // убрать внутренности Node, оставить строки из навыка/воркера
  const self = __filename.replace(/\\/g, '/');
  const lines = text.split('\n').filter(l => !/node:internal|\(node:|node_modules/.test(l) && !l.replace(/\\/g, '/').includes(self));
  let out = lines.slice(0, STACK_LINES);
  if (lines.length > STACK_LINES) out.push(`... (ещё ${lines.length - STACK_LINES} строк стека скрыто)`);
  text = out.join('\n');
  const brainDir = __dirname.replace(/\\/g, '/');
  text = text.replace(/\\/g, '/').split(brainDir + '/').join('brain/');
  if (Array.isArray(e._viaSkill) && e._viaSkill.length) text += '\nвызвано через skill(): ' + e._viaSkill.join(' <- ');
  if (e.result !== undefined && e.result !== null) {
    try { text += '\nрезультат тела: ' + JSON.stringify(e.result).slice(0, 500); } catch (er) {}
  }
  return text;
}

// ---------- Проверка формата ----------
function validate(mod, name) {
  const errors = []; const warnings = [];
  if (!mod || typeof mod !== 'object') {
    errors.push('module.exports должен быть объектом {name, description, params, run}');
    return { errors, warnings };
  }
  if (typeof mod.name !== 'string' || !mod.name) errors.push('нет поля name (строка)');
  // версия build_hut_v3.js может называться и build_hut_v3, и build_hut (копия прежней версии)
  else if (mod.name !== name && !(/_v\d{1,3}$/.test(name) && name.replace(/_v\d{1,3}$/, '') === mod.name)) errors.push(`name "${mod.name}" не совпадает с именем файла "${name}.js" (у версии <имя>_vN можно name <имя>)`);
  if (typeof mod.description !== 'string' || !mod.description.trim()) errors.push('нет description (непустая строка: что делает и когда применять)');
  if (typeof mod.run !== 'function') errors.push('нет функции run(api, params)');
  else if (mod.run.length > 2) warnings.push('run принимает больше 2 аргументов: используются только (api, params)');
  if (mod.params === undefined) warnings.push('нет params ({имя: описание}); укажи {} если параметров нет');
  else if (mod.params === null || typeof mod.params !== 'object' || Array.isArray(mod.params)) errors.push('params должен быть объектом {имя: описание}');
  return { errors, warnings };
}

function loadSkillModule(file, name) {
  const mod = require(file);
  const v = validate(mod, name);
  if (v.errors.length) throw new Error(`навык ${name} не прошёл проверку: ` + v.errors.join('; '));
  return mod;
}

// ---------- API для навыка (поверх HTTP тела) ----------
function makeApi(ctx, depth, skillName) {
  const url = ctx.bodyUrl;
  const sleepMs = ms => new Promise(r => setTimeout(r, Math.max(0, Number(ms) || 0)));

  async function bodyCall(action, params, extra) {
    let r;
    // src — кто отдал действие: тело пишет его в чёрный ящик и учёт ресурсов (верит только запросам исполнителя)
    const src = skillName ? { src: 'skill:' + skillName } : {};
    try { r = await bodyapi.post(url, '/cmd', { action, params: params || {}, ...extra, ...src }); }
    catch (e) { throw new Error(`cmd(${action}): ${e.message}`); }
    return r;
  }

  const api = {
    // Снимок тела: summary, eyes, inventory [{slot,name,count}], health, food, position...
    async snapshot() {
      try { return await bodyapi.get(url, '/snapshot'); } catch (e) { throw new Error('snapshot(): ' + e.message); }
    },
    // Синхронный вызов навыка тела. Возвращает result или бросает Error с причиной от тела.
    async cmd(action, params, opts) {
      if (typeof action !== 'string' || !action) throw new Error('cmd(action, params): action — непустая строка');
      const extra = { wait: true };
      if (opts && opts.force) extra.force = true;
      const r = await bodyCall(action, params, extra);
      if (!r || r.ok === false) {
        const e = new Error(`навык тела "${action}" не удался: ${(r && (r.error || r.reason)) || 'без причины'}`);
        if (r && r.result !== undefined) e.result = r.result;
        throw e;
      }
      return r.result !== undefined ? r.result : r;
    },
    // Фоновый запуск навыка тела. Возвращает {ok, taskId}. Результат — через wait()/events().
    async start(action, params, opts) {
      if (typeof action !== 'string' || !action) throw new Error('start(action, params): action — непустая строка');
      const extra = {};
      if (opts && opts.force) extra.force = true;
      const r = await bodyCall(action, params, extra);
      if (!r || r.ok === false) throw new Error(`не удалось запустить "${action}": ${(r && r.error) || 'без причины'}`);
      return r;
    },
    // Ждать важные события тела (long-poll). Ответ: {timedOut, events, cursor, task, summary}
    async wait(timeout, since) {
      const t = Math.min(Math.max(Number(timeout) || 60, 1), 300);
      const q = `/wait?timeout=${t}` + (since != null ? `&since=${encodeURIComponent(since)}` : '');
      try { return await bodyapi.get(url, q); } catch (e) { throw new Error('wait(): ' + e.message); }
    },
    // Журнал событий тела начиная с id > since
    async events(since, limit) {
      const q = `/events?since=${parseInt(since, 10) || 0}` + (limit ? `&limit=${parseInt(limit, 10) || 50}` : '');
      try { return await bodyapi.get(url, q); } catch (e) { throw new Error('events(): ' + e.message); }
    },
    // Прервать текущий навык тела
    async stop() { return bodyCall('stop', {}, {}); },
    // Вызвать другой выученный навык. Глубина вложенности не больше 3.
    async skill(name, params) {
      if (depth >= MAX_DEPTH) throw new Error(`skill("${name}"): вложенность глубже ${MAX_DEPTH} запрещена (защита от рекурсии)`);
      if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{1,39}$/.test(name)) throw new Error(`skill(): плохое имя навыка "${name}"`);
      if (ctx.disabled.includes(name)) throw new Error(`skill("${name}"): навык выключен`);
      let mod;
      try { mod = loadSkillModule(path.join(ctx.learnedDir, name + '.js'), name); }
      catch (e) {
        send({ type: 'nested', name, ok: false, error: fmtError(e) });
        const err = new Error(`skill("${name}"): не загрузился: ${e.message}`);
        err._reported = true;
        throw err;
      }
      api.log(`→ skill ${name}`);
      try {
        let res = await mod.run(makeApi(ctx, depth + 1, name), params && typeof params === 'object' ? params : {});
        if (res === undefined) res = { ok: true };
        const ok = !(res && typeof res === 'object' && res.ok === false);
        send({ type: 'nested', name, ok, error: ok ? null : String(res.error || 'ok:false') });
        api.log(`← skill ${name} ${ok ? 'ok' : 'провал'}`);
        return res;
      } catch (e) {
        const err = (e && typeof e === 'object') ? e : new Error(String(e));
        // виноват самый внутренний навык: сообщаем о провале один раз
        if (!err._reported) { err._reported = true; send({ type: 'nested', name, ok: false, error: fmtError(err) }); }
        (err._viaSkill = err._viaSkill || []).push(name);
        throw err;
      }
    },
    sleep: sleepMs,
    log(msg) {
      let s;
      try { s = typeof msg === 'string' ? msg : JSON.stringify(msg); } catch (e) { s = String(msg); }
      send({ type: 'log', msg: String(s).slice(0, 500) });
    },
    // Удобство: сколько предметов в инвентаре. count('dirt'), count(['dirt','cobblestone']), count(/_log$/)
    async count(names) {
      const snap = await api.snapshot();
      const inv = Array.isArray(snap.inventory) ? snap.inventory : [];
      const test = names instanceof RegExp ? n => names.test(n)
        : Array.isArray(names) ? n => names.includes(n) : n => n === names;
      return inv.filter(i => test(i.name)).reduce((s, i) => s + i.count, 0);
    }
  };
  return api;
}

// ---------- Режимы ----------
async function main(msg) {
  const { mode, file, name } = msg;
  if (mode === 'check') {
    try {
      const mod = require(file);
      const v = validate(mod, name);
      send({
        type: 'result', ok: v.errors.length === 0, errors: v.errors, warnings: v.warnings,
        meta: v.errors.length ? null : { name: mod.name, description: mod.description, params: mod.params || {} }
      });
    } catch (e) {
      send({ type: 'result', ok: false, errors: ['файл не загрузился: ' + fmtError(e)], warnings: [], meta: null });
    }
    return;
  }
  if (mode === 'run') {
    const ctx = { bodyUrl: msg.bodyUrl, learnedDir: msg.learnedDir, disabled: msg.disabled || [] };
    let mod;
    try { mod = loadSkillModule(file, name); }
    catch (e) { return send({ type: 'result', ok: false, error: fmtError(e) }); }
    try {
      let res = await mod.run(makeApi(ctx, 0, name), msg.params && typeof msg.params === 'object' ? msg.params : {});
      if (res === undefined || res === null) res = { ok: true };
      if (typeof res !== 'object' || Array.isArray(res)) res = { ok: true, result: res };
      if (res.ok === false) return send({ type: 'result', ok: false, error: String(res.error || 'навык вернул ok:false без error'), value: res });
      if (res.ok === undefined) res = { ok: true, ...res };
      send({ type: 'result', ok: true, value: res });
    } catch (e) {
      send({ type: 'result', ok: false, error: fmtError(e) });
    }
    return;
  }
  send({ type: 'result', ok: false, error: 'неизвестный режим ' + mode });
}

let started = false;
process.on('message', msg => {
  if (started) return;
  started = true;
  main(msg).catch(e => send({ type: 'result', ok: false, error: fmtError(e) }));
});
process.on('uncaughtException', e => { send({ type: 'result', ok: false, error: 'необработанное исключение: ' + fmtError(e) }); setTimeout(() => process.exit(1), 50); });
process.on('unhandledRejection', e => { send({ type: 'result', ok: false, error: 'необработанный reject: ' + fmtError(e) }); setTimeout(() => process.exit(1), 50); });
