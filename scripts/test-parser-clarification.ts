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

  const needsAssigneeWithPartial = parseParserModelOutput(
    JSON.stringify({
      status: 'needs_clarification',
      question: 'Siapa yang akan mengerjakan task ini?',
      missing_fields: ['assignee'],
      task: 'Weekly report',
      assignee_hint: null,
      due_date: '2026-06-02T08:00:00Z',
      priority: 'high',
      project: 'BCA',
      confidence: 0.7,
    })
  );

  assert.equal(needsAssigneeWithPartial.status, 'needs_clarification');
  if (needsAssigneeWithPartial.status === 'needs_clarification') {
    assert.equal(needsAssigneeWithPartial.missing_fields[0], 'assignee');
    assert.equal(needsAssigneeWithPartial.partial_task?.task, 'Weekly report');
    assert.equal(needsAssigneeWithPartial.partial_task?.project, 'BCA');
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

  const missingStatus = parseParserModelOutput(
    JSON.stringify({
      task: 'Submit timesheet',
      assignee_hint: null,
      due_date: '2026-06-01T10:00:00Z',
      priority: 'medium',
      project: null,
      confidence: 0.88,
    })
  );

  assert.equal(missingStatus.status, 'ok');
  if (missingStatus.status === 'ok') {
    assert.equal(missingStatus.task.task, 'Submit timesheet');
  }

  const nestedTask = parseParserModelOutput(
    JSON.stringify({
      status: 'ok',
      task: {
        task: 'Submit timesheet',
        assignee_hint: null,
        due_date: '2026-06-01T10:00:00Z',
        priority: 'medium',
        project: null,
        confidence: 0.88,
      },
    })
  );

  assert.equal(nestedTask.status, 'ok');
  if (nestedTask.status === 'ok') {
    assert.equal(nestedTask.task.task, 'Submit timesheet');
  }

  console.log('Parser clarification tests passed');
}

run();
