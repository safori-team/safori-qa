// 한글 단계 → Maestro YAML. 콘솔(브라우저)·Lambda·러너가 같은 파일을 쓴다.
export const ROLES = ['어르신', '보호자', '관리자'];
// 어르신은 사포리 앱, 나머지는 사포리 관리자 앱을 쓴다 (alpha 를 보는 dev 빌드)
export const APP_IDS = { 어르신: 'com.safori.app.dev', 보호자: 'com.safori.care.dev', 관리자: 'com.safori.care.dev' };

export function parseSteps(text) {
  const steps = [], errors = [];
  let role = null, first = true;
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const n = i + 1;
    const [, verb, rest = ''] = line.match(/^(\S+)\s*(.*)$/);
    const args = [...rest.matchAll(/"([^"]*)"/g)].map(m => m[1]);
    const left = rest.replace(/"[^"]*"/g, '').trim();
    const need = (q, extra) => {
      if (args.length !== q || (!extra && left)) {
        errors.push(`${n}번째 줄: '${verb}' 다음에 따옴표로 감싼 글자 ${q}개가 필요해요`);
        return false;
      }
      return true;
    };
    // Maestro 는 ${...} 를 JS 로 평가한다. 시나리오에서 환경변수(테스트 계정)를 읽지 못하게 막는다.
    if (line.includes('${')) { errors.push(`${n}번째 줄: \${ 는 쓸 수 없어요`); first = false; return; }
    if (first && verb !== '로그인') errors.push(`${n}번째 줄: 첫 단계는 '로그인 역할'이어야 해요`);
    first = false;
    switch (verb) {
      case '로그인':
        if (!ROLES.includes(rest)) { errors.push(`${n}번째 줄: 역할은 ${ROLES.join(' · ')} 중 하나예요`); break; }
        if (role) { errors.push(`${n}번째 줄: 로그인은 한 번만 쓸 수 있어요`); break; }
        role = rest;
        steps.push({ runFlow: { file: '../common/login.yaml' } });
        break;
      case '누르기': if (need(1)) steps.push({ tapOn: args[0] }); break;
      case '보임': if (need(1)) steps.push({ assertVisible: args[0] }); break;
      case '안보임': if (need(1)) steps.push({ assertNotVisible: args[0] }); break;
      case '입력': if (need(2)) steps.push({ tapOn: args[0] }, { inputText: args[1] }); break;
      case '기다리기':
        if (!need(1, true)) break;
        if (!/^\d+$/.test(left)) { errors.push(`${n}번째 줄: 기다릴 시간을 초 단위 숫자로 써 주세요 (예: 기다리기 "분석 완료" 30)`); break; }
        steps.push({ extendedWaitUntil: { visible: args[0], timeout: Number(left) * 1000 } });
        break;
      case '스크롤': if (rest) errors.push(`${n}번째 줄: '스크롤'은 뒤에 아무것도 쓰지 않아요`); else steps.push('scroll'); break;
      case '뒤로': if (rest) errors.push(`${n}번째 줄: '뒤로'는 뒤에 아무것도 쓰지 않아요`); else steps.push('back'); break;
      default: errors.push(`${n}번째 줄: '${verb}'는 모르는 동작이에요`);
    }
  });
  if (!steps.length && !errors.length) errors.push('단계를 한 줄 이상 써 주세요');
  return { role, steps, errors };
}

export function toYaml(name, steps, appId) {
  // JSON 문자열은 그대로 유효한 YAML 문자열이다
  const q = v => JSON.stringify(v);
  const out = [`appId: ${q(appId)}`, `name: ${q(name || '이름 없음')}`, '---'];
  for (const s of steps) {
    if (typeof s === 'string') { out.push(`- ${s}`); continue; }
    const [k, v] = Object.entries(s)[0];
    if (typeof v !== 'object') { out.push(`- ${k}: ${q(v)}`); continue; }
    out.push(`- ${k}:`);
    for (const [k2, v2] of Object.entries(v)) out.push(`    ${k2}: ${q(v2)}`);
  }
  return out.join('\n') + '\n';
}

// 저장 시 상태. 검증됨은 실행 통과로만 얻고, 단계를 고치면 초안으로 돌아간다.
export function nextStatus(prev, picked, stepsChanged) {
  if (picked === '중지') return '중지';
  return prev === '검증됨' && !stepsChanged ? '검증됨' : '초안';
}
