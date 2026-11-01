// 시나리오 실행기. 러너(public 레포)에서 돌기 때문에 stdout 에는 id 와 결과만 찍는다.
// 시나리오 내용·Maestro 출력·스크린샷은 S3 에만 남긴다.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { parseSteps, toYaml } from '../shared/steps.js';
import { SCENARIOS, runsKey, getJson, putBytes, updateJson } from '../shared/store.js';

const { QA_ACCOUNTS, QA_APP_ID, APK_VERSION = 'latest' } = process.env;
const accounts = JSON.parse(QA_ACCOUNTS ?? '{}');
const GEN = 'maestro/.generated', OUT = '.out';
const RUN_HISTORY = 50;

// 실패 원인을 JUnit 리포트에서 꺼낸다. 형식이 바뀌어도 '실행 실패'로 떨어지게 둔다.
export function failureMessage(xml) {
  const m = xml.match(/<failure[^>]*message="([^"]*)"/) ?? xml.match(/<failure[^>]*>([^<]*)</);
  return m?.[1]?.trim().slice(0, 300) || '실행 실패';
}

function runFlow(s, steps) {
  const flow = `${GEN}/${s.id}.yaml`, report = `${OUT}/${s.id}.xml`;
  writeFileSync(flow, toYaml(s.name, steps, QA_APP_ID));
  const { id, pw } = accounts[s.role];
  // 비밀번호가 찍히지 않도록 출력은 버린다
  const r = spawnSync('maestro', ['test', '-e', `APP_ID=${QA_APP_ID}`, '-e', `QA_ID=${id}`, '-e', `QA_PW=${pw}`, '--format', 'junit', '--output', report, flow], { stdio: 'ignore' });
  return { ok: r.status === 0, xml: existsSync(report) ? readFileSync(report, 'utf8') : '' };
}

async function screenshot(id, ranAt) {
  const r = spawnSync('adb', ['exec-out', 'screencap', '-p'], { maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout?.length) return null;
  const key = `screenshots/${id}/${ranAt.replace(/[:.]/g, '-')}.png`;
  await putBytes(key, r.stdout, 'image/png');
  return key;
}

// 같은 시나리오로 열린 이슈가 있으면 코멘트만 단다. public 이라 이름과 id 만 적는다.
function ticket(s) {
  const gh = (...args) => spawnSync('gh', args, { encoding: 'utf8' });
  const tag = `[QA #${s.id}]`;
  const open = JSON.parse(gh('issue', 'list', '--label', 'qa-fail', '--state', 'open', '--json', 'number,title,url').stdout || '[]');
  const found = open.find(i => i.title.startsWith(tag));
  const note = `실패 (APK ${APK_VERSION}). 상세 내용은 QA 콘솔의 시나리오 #${s.id}에서 확인해 주세요.`;
  if (found) { gh('issue', 'comment', String(found.number), '--body', note); return found.url; }
  return gh('issue', 'create', '--title', `${tag} ${s.name}`, '--label', 'qa-fail', '--body', note).stdout.trim() || null;
}

export async function record(s, run) {
  await updateJson(runsKey(s.id), [], list => [run, ...list].slice(0, RUN_HISTORY));
  await updateJson(SCENARIOS, [], list => list.map(x => x.id !== s.id ? x : {
    ...x, lastResult: run.result, lastRunAt: run.ranAt,
    // 실행 중에 단계가 고쳐졌으면 승격하지 않는다
    status: x.status === '초안' && run.result === '통과' && x.steps === s.steps ? '검증됨' : x.status,
  }));
}

async function main() {
  rmSync(GEN, { recursive: true, force: true });
  mkdirSync(GEN, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const { data } = await getJson(SCENARIOS, []);
  let failed = 0;
  for (const s of data.filter(x => x.status !== '중지')) {
    const ranAt = new Date().toISOString(), base = { ranAt, apkVersion: APK_VERSION };
    const { steps, errors } = parseSteps(s.steps);
    let run;
    if (errors.length) run = { ...base, result: '형식오류', message: errors[0] };
    else {
      const { ok, xml } = runFlow(s, steps);
      run = ok ? { ...base, result: '통과' }
        : { ...base, result: '실패', message: failureMessage(xml), screenshotKey: await screenshot(s.id, ranAt) };
    }
    if (run.result !== '통과' && s.status === '검증됨') { failed++; run.issueUrl = ticket(s); }
    await record(s, run);
    console.log(`#${s.id} ${run.result}`);
  }
  // 앱 결함 판단은 이슈로 한다. 워크플로우는 실행 자체가 깨졌을 때만 빨갛게 둔다.
  console.log(`검증됨 실패 ${failed}건`);
}

if (import.meta.main ?? process.argv[1]?.endsWith('run.js')) await main();
