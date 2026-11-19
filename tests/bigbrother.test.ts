/**
 * BIGBROTHER tests.
 *
 * Covers the parts that must not be decorative: the navigation registry matches
 * real pages, file answers come from the index, conversations are owned by one
 * account, memory is real, tutorials carry uploaded images, and error answers
 * read the error store.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'darknote-bb-'));
process.env.DARKNOTE_DATA_DIR = dataDir;
process.env.DARKNOTE_DB_DRIVER = 'pglite';
process.env.DARKNOTE_SECRET = 'test-secret-value-that-is-long-enough-for-aes-256-gcm';
process.env.NODE_ENV = 'test';
delete process.env.DARKNOTE_AI_API_KEY;

const { query } = await import('../src/lib/db.ts');
const { createServer } = await import('../src/lib/servers/repo.ts');
const { detectIntent } = await import('../src/lib/bigbrother/intent.ts');
const { invalidNavHrefs, findPages, findTutorials } = await import('../src/lib/bigbrother/nav.ts');
const { searchProject, runtimeFacts, errorsForQuestion } = await import('../src/lib/bigbrother/tools.ts');
const { answer } = await import('../src/lib/bigbrother/engine.ts');
const {
  createConversation,
  listConversations,
  getConversation,
  appendMessage,
  deleteConversation,
  setMemory,
  listMemory,
  recall,
} = await import('../src/lib/bigbrother/memory.ts');
const { saveAsset, readAsset } = await import('../src/lib/bigbrother/assets.ts');
const { createTutorial, listTutorials, deleteTutorial } = await import('../src/lib/bigbrother/tutorials.ts');
const { recordError } = await import('../src/lib/errors/store.ts');
const { ABOUT_BIGBROTHER } = await import('../src/lib/bigbrother/content.ts');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);

const principalA = {
  id: 'user-a',
  email: 'a@example.com',
  name: 'Alice',
  role: 'owner' as const,
  permissions: [],
};
const principalB = {
  id: 'user-b',
  email: 'b@example.com',
  name: 'Bob',
  role: 'viewer' as const,
  permissions: [],
};

await query(
  `insert into admin_users (id, email, name, password_hash, role) values ($1,$2,$3,$4,'owner')
   on conflict (id) do nothing`,
  [principalA.id, principalA.email, principalA.name, 'x'],
);
await query(
  `insert into admin_users (id, email, name, password_hash, role) values ($1,$2,$3,$4,'viewer')
   on conflict (id) do nothing`,
  [principalB.id, principalB.email, principalB.name, 'x'],
);

const server = await createServer(
  {
    name: 'Darknote L2',
    panelUrl: 'https://panel.invalid',
    serverIdentifier: 'abc12345',
    apiKey: 'ptlc_test_key',
  },
  principalA,
);

// Seed a realistic slice of the index.
await query(
  `insert into file_indexes (id, server_id, path, name, parent_path, is_directory, size_bytes)
   values ('f1',$1,'/','/', '/', true, 0),
          ('f2',$1,'/plugins','plugins','/', true, 0),
          ('f3',$1,'/main.js','main.js','/', false, 1200),
          ('f4',$1,'/plugins/welcome.js','welcome.js','/plugins', false, 900),
          ('f5',$1,'/lib/connect.js','connect.js','/lib', false, 700)`,
  [server.id],
);
await query(
  `insert into file_contents (server_id, path, sha256, content, bytes)
   values ($1,'/plugins/welcome.js','h1',$2,100)`,
  [server.id, "module.exports = async (sock, msg) => {\n  switch (cmd) {\n    case 'welcome':\n      await reply(sock, msg, 'hi');\n      break;\n  }\n}\n"],
);
await query(
  `insert into command_metadata (id, server_id, path, kind, name, aliases, line_start, line_end)
   values ('c1',$1,'/plugins/welcome.js','case','welcome','["hi"]'::jsonb,3,5)`,
  [server.id],
);

test('every link the assistant can produce resolves to a real page', () => {
  const invalid = invalidNavHrefs();
  assert.deepEqual(invalid, [], `invalid navigation hrefs: ${invalid.join(', ')}`);
  assert.ok(findPages('where is the error center').some((match) => match.page.href === '/errors'));
  assert.ok(findPages('file manager').some((match) => match.page.href === '/files'));
});

test('intent routing follows the questions the owner actually asks', () => {
  assert.equal(detectIntent('Who created you?').intent, 'identity');
  assert.equal(detectIntent('Where can I find my plugins?').intent, 'file_search');
  assert.equal(detectIntent('How do I restart my bot?').intent, 'guide');
  assert.equal(detectIntent('Where can I get the Pterodactyl Client API Key?').intent, 'navigation');
  assert.equal(detectIntent('Why is my Live Monitor showing Unknown?').intent, 'guide');
  assert.equal(detectIntent('Why am I getting a 405?').intent, 'error_explain');
  assert.equal(detectIntent('Where did I stop last time?').intent, 'memory_recall');
  assert.equal(detectIntent('Run a diagnostic check').intent, 'diagnostics');
});

test('file search returns real indexed paths, lines and commands', async () => {
  const main = await searchProject(server.id, 'main.js');
  assert.ok(main.hits.some((hit) => hit.path === '/main.js'));
  assert.equal(main.indexedFiles, 3);

  const command = await searchProject(server.id, 'welcome');
  const hit = command.hits.find((item) => item.kind === 'case');
  assert.ok(hit, 'the welcome case must be found through command metadata');
  assert.equal(hit?.path, '/plugins/welcome.js');
  assert.equal(hit?.line, 3);
  assert.match(hit?.openHref ?? '', /^\/editor\?path=%2Fplugins%2Fwelcome\.js&line=3$/);

  const missing = await searchProject(server.id, 'nonexistent-module');
  assert.equal(missing.hits.length, 0);
  assert.match(missing.notes.join(' '), /Nothing in the index matches/);
});

test('answers cite the index and never invent a path', async () => {
  const found = await answer({
    question: 'Where is my main.js file?',
    user: principalA,
    server,
    conversationId: 'not-a-real-conversation',
  });
  assert.equal(found.intent, 'file_search');
  assert.match(found.text, /\/main\.js/);

  const absent = await answer({
    question: 'Find the telemetry-sender.js file',
    user: principalA,
    server,
    conversationId: 'not-a-real-conversation',
  });
  assert.match(absent.text, /found nothing|No path/);
  assert.equal(absent.blocks.some((block) => block.type === 'files'), false);
});

test('identity is the configured identity, not a generic chatbot persona', async () => {
  const result = await answer({
    question: 'Who created you?',
    user: principalA,
    server,
    conversationId: 'x',
  });
  assert.equal(result.text, ABOUT_BIGBROTHER.identity);
  assert.match(result.text, /I am BIGBROTHER, the intelligent assistant of DARKNOTE/);
  assert.match(result.text, /created by BIGBROTHER, the owner of the DARKNOTE project/);
});

test('navigation answers carry working links and a real procedure', async () => {
  const result = await answer({
    question: 'Where can I get the Pterodactyl Client API Key?',
    user: principalA,
    server,
    conversationId: 'x',
  });
  const steps = result.blocks.find((block) => block.type === 'steps');
  assert.ok(steps && steps.type === 'steps');
  assert.ok(steps.steps.length >= 5);
  assert.ok(result.actions.some((action) => action.href === '/settings'));
  assert.match(result.text, /Client API key|panel/i);
});

test('conversations are stored per account and cannot be read across accounts', async () => {
  const conversation = await createConversation(principalA.id, { serverId: server.id, title: 'Key setup' });
  await appendMessage(principalA.id, conversation.id, { role: 'user', content: 'Where do I create the key?' });
  await appendMessage(principalA.id, conversation.id, {
    role: 'assistant',
    content: 'Account → API Credentials.',
    intent: 'guide',
    engine: 'grounded',
  });

  const owned = await getConversation(principalA.id, conversation.id);
  assert.equal(owned.messages.length, 2);
  assert.equal(owned.conversation.messageCount, 2);

  await assert.rejects(() => getConversation(principalB.id, conversation.id), /Conversation not found/);
  await assert.rejects(() => deleteConversation(principalB.id, conversation.id), /Conversation not found/);
  const bList = await listConversations(principalB.id);
  assert.equal(bList.length, 0);

  const removed = await deleteConversation(principalA.id, conversation.id);
  void removed;
  await assert.rejects(() => getConversation(principalA.id, conversation.id), /Conversation not found/);
});

test('memory makes "where did I stop" truthful and account scoped', async () => {
  const empty = await recall(principalB.id);
  assert.equal(empty.hasHistory, false);

  const conversation = await createConversation(principalA.id, { title: 'API key help' });
  await appendMessage(principalA.id, conversation.id, { role: 'user', content: 'Where do I create a Client API key?' });
  await appendMessage(principalA.id, conversation.id, {
    role: 'assistant',
    content: 'Open the panel, then Account → API Credentials, and create a key that starts with ptlc_.',
  });

  await setMemory(principalA.id, 'panel', { note: 'panel.example.com' });
  const facts = await listMemory(principalA.id);
  assert.ok(facts.some((fact) => fact.key === 'panel'));

  const memory = await recall(principalA.id, { excludeConversationId: 'other' });
  assert.equal(memory.hasHistory, true);
  assert.equal(memory.lastConversation?.id, conversation.id);
  assert.ok(memory.exchanges.some((exchange) => /Account → API Credentials/.test(exchange.content)));

  const answerResult = await answer({
    question: 'Where did I stop?',
    user: principalA,
    server,
    conversationId: 'some-other-conversation',
  });
  assert.match(answerResult.text, /most recent saved conversation/i);
  assert.match(answerResult.text, /Client API key/i);
  assert.ok(answerResult.actions.some((action) => action.href?.includes(`c=${conversation.id}`)));

  const bAnswer = await answer({
    question: 'Where did I stop?',
    user: principalB,
    server,
    conversationId: 'b-conversation',
  });
  assert.match(bAnswer.text, /do not have a saved earlier conversation/i);
});

test('uploaded screenshots are validated, owned and used inside tutorial steps', async () => {
  const asset = await saveAsset(principalA.id, { filename: 'account-menu.png', buffer: PNG });
  assert.equal(asset.mime, 'image/png');
  assert.match(asset.url, /^\/api\/bigbrother\/assets\/ast_/);

  const read = await readAsset(principalA.id, asset.id);
  assert.equal(read.mime, 'image/png');
  await assert.rejects(() => readAsset(principalB.id, asset.id), /Image not found/);

  await assert.rejects(
    () => saveAsset(principalA.id, { filename: 'fake.png', buffer: Buffer.from('not an image') }),
    /Only PNG, JPEG, GIF or WebP/,
  );

  const tutorial = await createTutorial(principalA.id, {
    title: 'Client API Key setup',
    summary: 'Use the panel account menu, then paste the key into DARKNOTE.',
    keywords: ['client api key', 'configure client api key', 'ptlc', 'api credentials'],
    steps: [
      { title: 'Open Account', body: 'Click your avatar, then Account.', assetId: asset.id, link: '/settings' },
      { title: 'Create the key', body: 'Account → API Credentials → Create API Key.', assetId: asset.id },
    ],
  });
  assert.equal(tutorial.steps.length, 2);
  assert.equal(tutorial.steps[0].assetUrl, `/api/bigbrother/assets/${asset.id}`);

  const listed = await listTutorials(principalA.id);
  assert.ok(listed.some((item) => item.id === tutorial.id));

  const matches = findTutorials('How do I configure the Client API Key?', listed.map((item) => ({
    slug: item.id,
    title: item.title,
    summary: item.summary,
    keywords: item.keywords,
    steps: item.steps.map((step) => ({ title: step.title, body: step.body, assetId: step.assetId ?? undefined, link: step.link ?? undefined })),
  })));
  assert.equal(matches[0]?.source, 'custom');

  const result = await answer({
    question: 'How do I configure the Client API Key?',
    user: principalA,
    server,
    conversationId: 'x',
  });
  assert.ok(result.images.length >= 1, 'the owner-uploaded screenshot must appear in the answer');
  assert.ok(result.blocks.some((block) => block.type === 'steps'));

  await assert.rejects(
    () => createTutorial(principalA.id, {
      title: 'Bad link',
      steps: [{ title: 'Go', body: 'nowhere', link: '/this-page-does-not-exist' }],
    }),
    /does not match a page/,
  );

  await deleteTutorial(principalA.id, tutorial.id);
});

test('error answers read the captured diagnostics and runtime facts', async () => {
  await recordError({
    message: 'SyntaxError: Unexpected token } at /main.js:12:4',
    source: 'console',
    serverId: server.id,
    filePath: '/main.js',
    line: 12,
  });
  await query(
    `insert into bot_status (id, server_id, container_state, whatsapp_state, whatsapp_signal)
     values ('bs1',$1,'running','unknown',null)`,
    [server.id],
  );

  const facts = await runtimeFacts(server.id);
  assert.equal(facts.containerState, 'running');
  assert.equal(facts.whatsappState, 'unknown');

  const found = await errorsForQuestion(server.id, 'why did my bot fail to restart?');
  assert.ok(found.matched.length >= 1);

  const result = await answer({
    question: 'Why did my bot fail to restart?',
    user: principalA,
    server,
    conversationId: 'x',
  });
  assert.equal(result.intent, 'error_explain');
  assert.ok(result.blocks.some((block) => block.type === 'errors'));
  assert.ok(result.actions.some((action) => action.href === '/errors'));
});

test('diagnostics state unknown rather than pretending health', async () => {
  const result = await answer({
    question: 'Run a diagnostic check',
    user: principalA,
    server,
    conversationId: 'x',
  });
  const block = result.blocks.find((item) => item.type === 'diagnostics');
  assert.ok(block && block.type === 'diagnostics');
  const whatsapp = block.findings.find((finding) => finding.id === 'whatsapp');
  assert.equal(whatsapp?.status, 'unknown');
  assert.match(whatsapp?.detail ?? '', /honest verdict|No connection event/);
});
