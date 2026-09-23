import assert from 'assert';
import { db } from './storage/db';
import { ruleEngine, MessageContext } from './services/ruleEngine';
import { messageScheduler } from './services/scheduler';

async function runTests() {
  console.log('--- Running Automated Tests for WA Automation Engine ---');

  // Test 1: Storage DB Settings
  console.log('[Test 1] Testing Database Settings...');
  const initialSettings = db.getSettings();
  assert(initialSettings.target_mode !== undefined, 'Target mode should exist');
  assert(initialSettings.system_prompt !== undefined, 'System prompt should exist');

  const updated = db.updateSettings({
    target_mode: 'contacts_only',
    cooldown_seconds: 10,
    whitelist: ['+1234567890'],
  });
  assert.strictEqual(updated.target_mode, 'contacts_only');
  assert.strictEqual(updated.cooldown_seconds, 10);
  assert.deepStrictEqual(updated.whitelist, ['+1234567890']);
  console.log('✓ DB Settings read & write passed');

  // Test 2: Message Storage & History
  console.log('[Test 2] Testing Message Storage & History...');
  const testJid = '1234567890@s.whatsapp.net';
  db.saveMessage({
    id: 'test_msg_1',
    jid: testJid,
    sender: testJid,
    content: 'Hello, bot!',
    from_me: false,
    is_group: false,
    timestamp: Math.floor(Date.now() / 1000) - 20,
    is_bot_reply: false,
  });

  db.saveMessage({
    id: 'test_msg_2',
    jid: testJid,
    sender: 'bot@s.whatsapp.net',
    content: 'Hello! How can I assist you?',
    from_me: true,
    is_group: false,
    timestamp: Math.floor(Date.now() / 1000) - 10,
    is_bot_reply: true,
  });

  const recent = db.getRecentMessages(testJid, 5);
  assert.strictEqual(recent.length, 2);
  assert.strictEqual(recent[0].content, 'Hello, bot!');
  assert.strictEqual(recent[1].content, 'Hello! How can I assist you?');
  console.log('✓ Message storage & retrieval passed');

  // Test 3: Campaign Context (Reply Tracking)
  console.log('[Test 3] Testing Campaign Context & Follow-up Tracking...');
  db.setCampaignContext(
    testJid,
    'Hey! Special deal for you: 50% off.',
    'Guide them to use code DISCOUNT50 and answer questions.'
  );

  const activeContext = db.getActiveCampaignContext(testJid);
  assert(activeContext !== null, 'Campaign context should be active');
  assert.strictEqual(activeContext?.initial_message, 'Hey! Special deal for you: 50% off.');
  assert.strictEqual(activeContext?.context_note, 'Guide them to use code DISCOUNT50 and answer questions.');
  console.log('✓ Campaign context tracking passed');

  // Test 4: Rule Engine Filtering Logic
  console.log('[Test 4] Testing Rule Engine Filtering Logic...');

  // 4.1 fromMe
  const selfMsg: MessageContext = {
    jid: testJid,
    sender: testJid,
    fromMe: true,
    isGroup: false,
    content: 'My own message',
    timestamp: Math.floor(Date.now() / 1000),
  };
  assert.strictEqual(ruleEngine.evaluate(selfMsg).shouldReply, false, 'Should ignore self message');

  // 4.2 Status broadcast
  const broadcastMsg: MessageContext = {
    jid: 'status@broadcast',
    sender: 'someone@s.whatsapp.net',
    fromMe: false,
    isGroup: false,
    content: 'Status update',
    timestamp: Math.floor(Date.now() / 1000),
  };
  assert.strictEqual(ruleEngine.evaluate(broadcastMsg).shouldReply, false, 'Should ignore broadcast');

  // 4.3 Contacts Only mode
  db.updateSettings({ target_mode: 'contacts_only' });
  const groupMsg: MessageContext = {
    jid: '120363012345678@g.us',
    sender: 'user@s.whatsapp.net',
    fromMe: false,
    isGroup: true,
    content: 'Group chat text',
    timestamp: Math.floor(Date.now() / 1000),
  };
  const contactMsg: MessageContext = {
    jid: '9876543210@s.whatsapp.net',
    sender: '9876543210@s.whatsapp.net',
    fromMe: false,
    isGroup: false,
    content: 'Personal chat text',
    timestamp: Math.floor(Date.now() / 1000),
  };
  assert.strictEqual(ruleEngine.evaluate(groupMsg).shouldReply, false, 'Contacts_only should block groups');
  assert.strictEqual(ruleEngine.evaluate(contactMsg).shouldReply, true, 'Contacts_only should allow direct contact');

  // 4.4 Groups Only mode
  db.updateSettings({ target_mode: 'groups_only' });
  assert.strictEqual(ruleEngine.evaluate(groupMsg).shouldReply, true, 'Groups_only should allow group');
  assert.strictEqual(ruleEngine.evaluate(contactMsg).shouldReply, false, 'Groups_only should block contact');

  // 4.5 Whitelist Only mode
  db.updateSettings({
    target_mode: 'whitelist_only',
    whitelist: ['9876543210', '120363012345678@g.us'],
  });
  const unwhitelistedMsg: MessageContext = {
    jid: '5555555555@s.whatsapp.net',
    sender: '5555555555@s.whatsapp.net',
    fromMe: false,
    isGroup: false,
    content: 'Hello stranger',
    timestamp: Math.floor(Date.now() / 1000),
  };
  assert.strictEqual(ruleEngine.evaluate(contactMsg).shouldReply, true, 'Whitelisted phone number should be allowed');
  assert.strictEqual(ruleEngine.evaluate(groupMsg).shouldReply, true, 'Whitelisted group JID should be allowed');
  assert.strictEqual(ruleEngine.evaluate(unwhitelistedMsg).shouldReply, false, 'Unwhitelisted message should be blocked');

  // 4.6 Blacklist
  db.updateSettings({
    target_mode: 'all',
    blacklist: ['9876543210'],
  });
  assert.strictEqual(ruleEngine.evaluate(contactMsg).shouldReply, false, 'Blacklisted contact should be blocked');
  assert.strictEqual(ruleEngine.evaluate(unwhitelistedMsg).shouldReply, true, 'Non-blacklisted contact should be allowed');

  console.log('✓ All Rule Engine test scenarios passed');

  // Test 5: Scheduler Tests
  console.log('[Test 5] Testing Scheduler...');
  const schedule = messageScheduler.addSchedule({
    recipient: '+1234567890',
    message: 'Automated test promo message',
    scheduledAt: new Date(Date.now() + 60000).toISOString(),
    contextNote: 'Follow-up promo note',
  });
  assert(schedule.id.startsWith('sch_'), 'Schedule ID should have prefix sch_');
  assert.strictEqual(schedule.recipient, '+1234567890');
  assert.strictEqual(schedule.status, 'pending');

  const formattedJid = messageScheduler.formatJid('+1 234 567 8900');
  assert.strictEqual(formattedJid, '12345678900@s.whatsapp.net');

  const deleted = messageScheduler.deleteSchedule(schedule.id);
  assert.strictEqual(deleted, true);
  console.log('✓ Scheduler creation, formatting, and deletion passed');

  // Test 6: System Logs
  console.log('[Test 6] Testing System Logging...');
  db.log('INFO', 'Test log entry', { key: 'value' });
  const logs = db.getLogs(10);
  assert(logs.length > 0);
  assert.strictEqual(logs[0].message, 'Test log entry');
  console.log('✓ System logging passed');

  console.log('\n==========================================');
  console.log('   ALL 6 TEST SUITES PASSED SUCCESSFULLY!  ');
  console.log('==========================================\n');
}

runTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
