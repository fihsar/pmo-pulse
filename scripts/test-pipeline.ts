import { parseTaskFromMessage } from '../src/lib/agents/parser';

const tests = [
  'Tasya weekly report BCA Jumat jam 4 sore penting',
  'Buat meeting prep client Mandiri besok jam 10 pagi',
  'Yugen review PRD kapan-kapan',
  'Submit timesheet hari ini',
  'Lunch dengan stakeholder Senin jam 12',
  'Follow up CIMB integration urgent',
  'Standup notes besok',
  'Quarterly review akhir bulan',
  'Beli kopi',
  'Tasya, status update BCA project minggu depan ASAP',
];

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.log('Skipping parser smoke test: GEMINI_API_KEY is not configured.');
    return;
  }

  let pass = 0;

  for (const test of tests) {
    const result = await parseTaskFromMessage(test);
    console.log(`\n📨 ${test}`);
    console.log('   →', result ? JSON.stringify(result) : 'NULL');

    if (result && result.task && result.confidence > 0.5) pass++;
  }

  console.log(`\n${pass}/${tests.length} parsed (target: 8+)`);

  if (pass < 8) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
