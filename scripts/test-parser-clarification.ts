import assert from 'node:assert/strict';
import { parseParserModelOutput } from '../src/lib/agents/parser';

function run() {
  const ambiguous = parseParserModelOutput(
    JSON.stringify({
      status: 'needs_clarification',
      question: 'Jam 5 maksudnya pagi atau sore?',
      missing_fields: ['due_time'],
    })
  );

  assert.equal(ambiguous.status, 'needs_clarification');
  if (ambiguous.status === 'needs_clarification') {
    assert.equal(ambiguous.question, 'Jam 5 maksudnya pagi atau sore?');
    assert.deepEqual(ambiguous.missing_fields, ['due_time']);
  }

  const valid = parseParserModelOutput(
    JSON.stringify({
      status: 'ok',
      task: 'Submit timesheet',
      assignee_hint: null,
      due_date: '2026-06-01T10:00:00Z',
      priority: 'medium',
      project: null,
      confidence: 0.88,
    })
  );

  assert.equal(valid.status, 'ok');
  if (valid.status === 'ok') {
    assert.equal(valid.task.task, 'Submit timesheet');
    assert.equal(valid.task.priority, 'medium');
  }

  const invalid = parseParserModelOutput('not json');
  assert.equal(invalid.status, 'error');

  console.log('Parser clarification tests passed');
}

run();
