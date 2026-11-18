/* Phase 2 로컬 스모크 테스트 — DB/추출/스케줄 계산이 실제로 도는지 확인한다. */
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.cwd(), '.uitest', 'phase2');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.DATA_DIR = dir;

async function main() {
  const jobs = await import('../server/jobs');
  const watchers = await import('../server/watchers');
  const policy = await import('../server/policy');

  console.log('== cron');
  console.log(jobs.scheduleLabel('0 8 * * *'), '|', jobs.scheduleLabel('*/5 * * * *'), '|', jobs.scheduleLabel('0 9 * * 1-5'));
  console.log(jobs.nextRuns('0 8 * * *', 'Asia/Seoul', 2));
  try {
    jobs.validateCron('* * *');
  } catch (err) {
    console.log('invalid cron rejected:', (err as Error).message.slice(0, 40));
  }

  console.log('== jobs');
  const job = jobs.createJob({ name: '아침 브리핑', cron: '0 8 * * *', prompt: '오늘 일정과 서버 상태를 요약해줘.' });
  console.log(job.name, job.scheduleLabel, job.nextRunAt, job.enabled);
  const updated = jobs.updateJob(job.id, { enabled: false });
  console.log('disabled nextRunAt =', updated.nextRunAt);
  jobs.updateJob(job.id, { enabled: true });

  console.log('== policy');
  for (const url of ['https://github.com/login', 'https://www.coupang.com/vp/products/1', 'https://www.kbstar.com', 'https://upbit.com', 'https://some-new-site.example.org/x', 'https://madcasino.io']) {
    const v = policy.evaluateUrl(url);
    console.log(url, '→', v.level, v.pattern);
  }
  console.log('payment click:', policy.evaluateBrowserAction('browser_click', { text: '결제하기' }));
  console.log('card type:', policy.evaluateBrowserAction('browser_type', { target: '카드번호' }));
  console.log('login type:', policy.evaluateBrowserAction('browser_type', { target: '아이디', text: 'hello' }));

  console.log('== watcher (example.com text)');
  const w = watchers.createWatcher({ name: '예제 페이지', url: 'https://example.com', mode: 'text', intervalMin: 30 });
  const first = await watchers.checkWatcherNow(w.id, 'manual');
  console.log('status', first.watcher.lastStatus, '| value:', first.value.slice(0, 60).replace(/\n/g, ' '));
  console.log('events', watchers.listEvents(w.id).map((e) => e.kind));

  console.log('== watcher (example.com selector)');
  const w2 = watchers.createWatcher({ name: '제목', url: 'https://example.com', mode: 'selector', target: 'h1' });
  const r2 = await watchers.checkWatcherNow(w2.id, 'manual');
  console.log('selector value:', r2.value, '| events', watchers.listEvents(w2.id).map((e) => e.kind));

  console.log('== watcher diff');
  console.log(watchers.diffSummary('가격 10,000원\n재고 있음', '가격 9,000원\n재고 있음'));

  console.log('== ping');
  const w3 = watchers.createWatcher({ name: '핑', url: 'https://example.com', mode: 'ping' });
  const r3 = await watchers.checkWatcherNow(w3.id, 'manual');
  console.log('ping:', r3.value);

  console.log('== runs');
  console.log(jobs.listRuns(undefined, 3).length, 'runs');
  console.log('OK');
}

main().catch((err) => {
  console.error('FAILED', err);
  process.exit(1);
});
