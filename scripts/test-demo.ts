import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseParserModelOutput } from '../src/lib/agents/parser';

function readText(filePath: string) {
  return fs.readFileSync(filePath, 'utf8');
}

function runParserContractTests() {
  const okFlat = parseParserModelOutput(JSON.stringify({
    status: 'ok',
    task: 'Create daily report',
    assignee_hint: 'Tasya',
    due_date: '2026-06-03T08:17:00Z',
    priority: 'medium',
    project: 'BCA',
    confidence: 0.9,
  }));

  assert.equal(okFlat.status, 'ok');
  if (okFlat.status === 'ok') {
    assert.equal(okFlat.task.task, 'Create daily report');
    assert.equal(okFlat.task.assignee_hint, 'Tasya');
    assert.equal(okFlat.task.priority, 'medium');
  }

  const okNested = parseParserModelOutput(JSON.stringify({
    status: 'ok',
    task: {
      task: 'Submit timesheet',
      assignee_hint: null,
      due_date: null,
      priority: 'low',
      project: null,
      confidence: 0.75,
    },
  }));

  assert.equal(okNested.status, 'ok');
  if (okNested.status === 'ok') {
    assert.equal(okNested.task.task, 'Submit timesheet');
    assert.equal(okNested.task.priority, 'low');
  }

  const okMissingStatus = parseParserModelOutput(JSON.stringify({
    task: 'Prepare weekly report',
    assignee_hint: null,
    due_date: '2026-06-05T10:00:00Z',
    priority: 'high',
    project: 'Mandiri',
    confidence: 0.88,
  }));

  assert.equal(okMissingStatus.status, 'ok');

  const needsAssigneeButOptional = parseParserModelOutput(JSON.stringify({
    status: 'needs_clarification',
    question: 'Siapa yang bertanggung jawab untuk laporan mingguan ini?',
    missing_fields: ['assignee'],
    task: 'Weekly report',
    assignee_hint: null,
    due_date: '2026-06-05T10:00:00Z',
    priority: 'medium',
    project: null,
    confidence: 0.7,
  }));

  assert.equal(needsAssigneeButOptional.status, 'ok');
  if (needsAssigneeButOptional.status === 'ok') {
    assert.equal(needsAssigneeButOptional.task.task, 'Weekly report');
    assert.equal(needsAssigneeButOptional.task.assignee_hint, null);
  }

  const invalidJson = parseParserModelOutput('not json');
  assert.equal(invalidJson.status, 'error');

  const incompleteJson = parseParserModelOutput('{"status":"ok","task":"X"');
  assert.equal(incompleteJson.status, 'error');
  if (incompleteJson.status === 'error') {
    assert.equal(incompleteJson.reason, 'Parser returned incomplete JSON');
  }
}

function runRepoSanityChecks(rootDir: string) {
  const vercelJson = JSON.parse(readText(path.join(rootDir, 'vercel.json'))) as {
    crons?: Array<{ path: string; schedule: string }>;
  };
  const cronPaths = (vercelJson.crons || []).map((c) => c.path);
  assert.ok(cronPaths.includes('/api/cron/reminders'));
  assert.ok(cronPaths.includes('/api/cron/report'));
  assert.ok(cronPaths.includes('/api/cron/standup'));

  const schema = readText(path.join(rootDir, 'supabase', 'schema.sql'));
  assert.ok(schema.includes('due_soon_reminded_at'));
  assert.ok(schema.includes('overdue_reminded_at'));
  assert.ok(schema.includes('partial_task jsonb'));
}

(function main() {
  const rootDir = process.cwd();
  runParserContractTests();
  runRepoSanityChecks(rootDir);
  console.log('Demo tests passed');
})();

