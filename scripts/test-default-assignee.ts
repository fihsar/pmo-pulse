import assert from 'node:assert/strict';
import { getDefaultAssigneePhone } from '../src/lib/agents/router';

function run() {
  const phone = getDefaultAssigneePhone();
  assert.equal(phone, '+628115344666');
  console.log('Default assignee test passed');
}

run();
