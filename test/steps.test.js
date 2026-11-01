import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSteps, toYaml, nextStatus } from '../shared/steps.js';

test('모든 동사를 Maestro 명령으로 바꾼다', () => {
  const r = parseSteps('# 메모\n로그인 어르신\n누르기 "일기"\n입력 "메모" "안녕"\n기다리기 "분석 완료" 30\n안보임 "오류"\n스크롤\n뒤로');
  assert.deepEqual(r.errors, []);
  assert.equal(r.role, '어르신');
  const y = toYaml('t', r.steps, 'a.b');
  for (const s of ['appId: "a.b"', 'file: "../common/login.yaml"', '- tapOn: "일기"', '- inputText: "안녕"', 'timeout: 30000', '- assertNotVisible: "오류"', '- scroll', '- back'])
    assert.ok(y.includes(s), s);
});

test('형식 오류는 줄 번호와 함께 알려주고 첫 줄 오류는 한 번만 낸다', () => {
  const { errors } = parseSteps('누르기 상태보드\n로그인 운영자\n기다리기 "x"');
  assert.equal(errors.filter(e => e.includes('첫 단계')).length, 1);
  assert.ok(errors.some(e => e.startsWith('2번째 줄: 역할은')));
  assert.ok(errors.some(e => e.startsWith('3번째 줄: 기다릴')));
});

test('${} 와 빈 입력을 거부한다', () => {
  assert.ok(parseSteps('로그인 보호자\n입력 "메모" "${QA_PW}"').errors[0].includes('쓸 수 없어요'));
  assert.ok(parseSteps('').errors.length);
});

test('따옴표가 든 이름도 YAML 이 깨지지 않는다', () => {
  assert.ok(toYaml('a"b\nc', []).includes(`name: ${JSON.stringify('a"b\nc')}`));
});

test('검증됨은 저장으로 얻을 수 없고 단계를 고치면 초안이 된다', () => {
  assert.equal(nextStatus('초안', '초안', false), '초안');
  assert.equal(nextStatus('검증됨', '초안', false), '검증됨');
  assert.equal(nextStatus('검증됨', '초안', true), '초안');
  assert.equal(nextStatus('검증됨', '중지', false), '중지');
  assert.equal(nextStatus('중지', '검증됨', false), '초안');
});
