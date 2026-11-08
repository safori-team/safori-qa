// Function URL 하나로 페이지와 API 를 함께 제공한다. 인증은 팀 공용 비밀번호 + 서명 쿠키.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSteps, nextStatus } from '../shared/steps.js';
import { SCENARIOS, runsKey, getJson, getBytes, updateJson } from '../shared/store.js';

const root = join(import.meta.dirname, '..');
const page = readFileSync(join(root, 'web/index.html'), 'utf8');
const stepsJs = readFileSync(join(root, 'shared/steps.js'), 'utf8');
const SESSION_DAYS = 7;

const json = (statusCode, body, extra = {}) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...extra,
});
const fail = (statusCode, message) => json(statusCode, { message });
const sign = exp => createHmac('sha256', process.env.QA_PASSWORD).update(`qa-session.${exp}`).digest('hex');
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

function isAuthed(event) {
  if (!process.env.QA_PASSWORD) return false;
  const cookie = (event.cookies ?? []).find(c => c.startsWith('qa_session='))?.slice('qa_session='.length);
  const [exp, sig] = (cookie ?? '').split('.');
  return Number(exp) > Date.now() && !!sig && same(sig, sign(exp));
}

function login(body) {
  // 비밀번호가 설정되지 않았으면 아무도 들어오지 못한다
  if (!process.env.QA_PASSWORD || !same(body.password ?? '', process.env.QA_PASSWORD)) return fail(401, '비밀번호가 맞지 않아요');
  const exp = Date.now() + SESSION_DAYS * 864e5;
  return json(200, { ok: true }, {
    cookies: [`qa_session=${exp}.${sign(exp)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`],
  });
}

function validate(body) {
  const name = String(body.name ?? '').trim(), updatedBy = String(body.updatedBy ?? '').trim();
  const steps = String(body.steps ?? '').trim();
  if (!name) return { error: '이름을 입력해 주세요' };
  if (!updatedBy) return { error: '수정자를 입력해 주세요' };
  const parsed = parseSteps(steps);
  if (parsed.errors.length) return { error: parsed.errors[0] };
  return { name, updatedBy, steps, role: parsed.role, picked: body.status };
}

async function create(body) {
  const v = validate(body);
  if (v.error) return fail(400, v.error);
  let created;
  await updateJson(SCENARIOS, [], list => {
    const id = Math.max(0, ...list.map(s => s.id)) + 1;
    created = {
      id, rev: 0, name: v.name, role: v.role, steps: v.steps, status: nextStatus(null, v.picked, true),
      updatedBy: v.updatedBy, updatedAt: new Date().toISOString(), lastResult: '미실행', lastRunAt: null,
    };
    return [created, ...list];
  });
  return json(201, created);
}

async function update(id, body) {
  const v = validate(body);
  if (v.error) return fail(400, v.error);
  let saved, res;
  await updateJson(SCENARIOS, [], list => {
    const s = list.find(x => x.id === id);
    res = !s ? fail(404, '시나리오를 찾을 수 없어요')
      : (s.rev ?? 0) !== body.baseRev ? fail(409, '다른 사람이 먼저 수정했어요. 새로고침한 뒤 다시 저장해 주세요')
      : null;
    if (res) return list;
    saved = {
      ...s, rev: (s.rev ?? 0) + 1, name: v.name, role: v.role, steps: v.steps, status: nextStatus(s.status, v.picked, s.steps !== v.steps),
      updatedBy: v.updatedBy, updatedAt: new Date().toISOString(),
    };
    return list.map(x => x.id === id ? saved : x);
  });
  return res ?? json(200, saved);
}

async function shot(key) {
  if (!/^screenshots\/\d+\/[\w.-]+\.png$/.test(key)) return fail(400, '잘못된 경로예요');
  return { statusCode: 200, headers: { 'content-type': 'image/png' }, isBase64Encoded: true, body: (await getBytes(key)).toString('base64') };
}

export async function handler(event) {
  const method = event.requestContext.http.method, path = event.rawPath;
  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : event.body;
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { return fail(400, '요청 형식이 맞지 않아요'); }

  if (method === 'GET' && path === '/') return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY' }, body: page };
  if (method === 'GET' && path === '/steps.js') return { statusCode: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: stepsJs };
  if (method === 'POST' && path === '/api/login') return login(body);
  if (!isAuthed(event)) return fail(401, '로그인이 필요해요');

  if (path === '/api/scenarios' && method === 'GET') return json(200, (await getJson(SCENARIOS, [])).data);
  if (path === '/api/scenarios' && method === 'POST') return create(body);
  let m;
  if ((m = path.match(/^\/api\/scenarios\/(\d+)$/)) && method === 'PUT') return update(Number(m[1]), body);
  if ((m = path.match(/^\/api\/scenarios\/(\d+)\/runs$/)) && method === 'GET') return json(200, (await getJson(runsKey(m[1]), [])).data);
  if (path.startsWith('/api/shots/') && method === 'GET') return shot(path.slice('/api/shots/'.length));
  return fail(404, '없는 경로예요');
}
