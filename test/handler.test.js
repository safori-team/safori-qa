import test from 'node:test';
import assert from 'node:assert/strict';
import { objects } from './s3-mock.js';

process.env.QA_PASSWORD = 'secret';
process.env.QA_BUCKET = 'test';
const { handler } = await import('../lambda/handler.js');
const { record, failureMessage } = await import('../scripts/run.js');
const { getJson, updateJson, SCENARIOS } = await import('../shared/store.js');

const call = async (method, rawPath, body, cookies) => {
  const res = await handler({ requestContext: { http: { method } }, rawPath, body: body && JSON.stringify(body), cookies });
  return { ...res, json: res.headers['content-type'] === 'application/json' ? JSON.parse(res.body) : null };
};
const session = async () => {
  const res = await call('POST', '/api/login', { password: 'secret' });
  return [res.cookies[0].split(';')[0]];
};
const STEPS = '로그인 보호자\n보임 "오늘"';
const save = (cookies, extra = {}) => call('POST', '/api/scenarios', { name: '시나리오', steps: STEPS, updatedBy: '김기획', ...extra }, cookies);

test('로그인 없이는 페이지만 열리고 API 는 막힌다', async () => {
  assert.equal((await call('GET', '/')).statusCode, 200);
  assert.equal((await call('GET', '/api/scenarios')).statusCode, 401);
  assert.equal((await call('GET', '/api/scenarios', null, ['qa_session=9999999999999.forged'])).statusCode, 401);
  assert.equal((await call('POST', '/api/login', { password: 'wrong' })).statusCode, 401);
});

test('비밀번호가 설정되지 않으면 아무도 들어오지 못한다', async () => {
  const cookies = await session();
  delete process.env.QA_PASSWORD;
  assert.equal((await call('GET', '/api/scenarios', null, cookies)).statusCode, 401);
  assert.equal((await call('POST', '/api/login', { password: '' })).statusCode, 401);
  process.env.QA_PASSWORD = 'secret';
});

test('만료된 쿠키는 거부한다', async () => {
  const [cookie] = await session();
  const sig = cookie.split('.')[1];
  assert.equal((await call('GET', '/api/scenarios', null, [`qa_session=1.${sig}`])).statusCode, 401);
});

test('저장 시 형식을 다시 검사하고 검증됨을 직접 넣을 수 없다', async () => {
  objects.clear();
  const cookies = await session();
  assert.equal((await save(cookies, { steps: '누르기 "x"' })).statusCode, 400);
  assert.equal((await save(cookies, { updatedBy: ' ' })).statusCode, 400);
  const res = await save(cookies, { status: '검증됨' });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json.status, '초안');
  assert.equal(res.json.role, '보호자');
});

test('다른 사람이 먼저 고쳤으면 409, 단계를 고치면 초안으로 돌아간다', async () => {
  objects.clear();
  const cookies = await session();
  const { json: s } = await save(cookies);
  await updateJson(SCENARIOS, [], list => list.map(x => ({ ...x, status: '검증됨' })));
  const put = extra => call('PUT', `/api/scenarios/${s.id}`, { name: 'n', steps: STEPS, updatedBy: 'a', baseRev: s.rev, ...extra }, cookies);
  const same = await put();
  assert.equal(same.json.status, '검증됨');
  // 같은 판(rev)을 보고 고친 두 번째 저장은 시각과 상관없이 막는다
  assert.equal((await put()).statusCode, 409);
  const changed = await put({ steps: `${STEPS}\n뒤로`, baseRev: same.json.rev });
  assert.equal(changed.json.status, '초안');
});

test('동시 생성에도 id 가 겹치지 않고 유실되지 않는다', async () => {
  objects.clear();
  const cookies = await session();
  await save(cookies);
  const results = await Promise.all([save(cookies), save(cookies), save(cookies)]);
  assert.ok(results.every(r => r.statusCode === 201));
  const ids = (await getJson(SCENARIOS, [])).data.map(s => s.id).sort();
  assert.deepEqual(ids, [1, 2, 3, 4]);
});

test('스크린샷 경로는 정해진 형식만 허용한다', async () => {
  const cookies = await session();
  assert.equal((await call('GET', '/api/shots/scenarios.json', null, cookies)).statusCode, 400);
  assert.equal((await call('GET', '/api/shots/screenshots/1/..%2F.png', null, cookies)).statusCode, 400);
});

test('초안은 통과하면 검증됨이 되고, 실행 중 고쳐졌으면 승격하지 않는다', async () => {
  objects.clear();
  const cookies = await session();
  const { json: s } = await save(cookies);
  await record({ ...s, steps: '예전 단계' }, { ranAt: 'r1', result: '통과' });
  assert.equal((await getJson(SCENARIOS, [])).data[0].status, '초안');
  await record(s, { ranAt: 'r2', result: '실패', message: 'm' });
  assert.equal((await getJson(SCENARIOS, [])).data[0].status, '초안');
  await record(s, { ranAt: 'r3', result: '통과' });
  const [after] = (await getJson(SCENARIOS, [])).data;
  assert.equal(after.status, '검증됨');
  assert.equal(after.lastRunAt, 'r3');
  const runs = await call('GET', `/api/scenarios/${s.id}/runs`, null, cookies);
  assert.deepEqual(runs.json.map(r => r.ranAt), ['r3', 'r2', 'r1']);
});

test('JUnit 실패 메시지를 꺼낸다', () => {
  assert.equal(failureMessage('<testcase><failure message="보이지 않음">x</failure></testcase>'), '보이지 않음');
  assert.equal(failureMessage('<failure>본문 메시지</failure>'), '본문 메시지');
  assert.equal(failureMessage(''), '실행 실패');
});
