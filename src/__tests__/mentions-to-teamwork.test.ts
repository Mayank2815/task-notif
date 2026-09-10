import assert from 'node:assert/strict';
import test from 'node:test';
import { mentionedUsers, plainText, toTeamworkHtml, type RichElement } from '../slack/rich-text.js';
import { handleFor, matchPerson, mentionHandlesFromHtml } from '../teamwork/people-directory.js';

/** What Slack's rich_text_input hands back for "Hi @Kiran, merged? *thanks*". */
const reply: RichElement = {
  type: 'rich_text',
  elements: [{
    type: 'rich_text_section',
    elements: [
      { type: 'text', text: 'Hi ' },
      { type: 'user', user_id: 'U_KIRAN' },
      { type: 'text', text: ', merged? ' },
      { type: 'text', text: 'thanks', style: { bold: true } },
    ],
  }],
};

const resolve = (id: string) => (id === 'U_KIRAN' ? { teamworkId: 400101, handle: 'Kiranm' } : null);

test('a Slack tag becomes the exact mention markup Teamwork\'s own editor writes', () => {
  const { html } = toTeamworkHtml(reply, resolve);
  // The shape Teamwork's own editor writes, captured from a real comment.
  assert.match(html, /<a href="\/app\/people\/400101" rel="noopener noreferrer nofollow" data-mention="true" target="_blank">@Kiranm<\/a>/);
});

test('whoever is tagged is who gets notified, by Teamwork id', () => {
  assert.deepEqual(toTeamworkHtml(reply, resolve).notify, [400101]);
});

test('tagging the same person twice notifies them once', () => {
  const twice: RichElement = { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [
    { type: 'user', user_id: 'U_KIRAN' }, { type: 'text', text: ' and again ' }, { type: 'user', user_id: 'U_KIRAN' },
  ] }] };
  assert.deepEqual(toTeamworkHtml(twice, resolve).notify, [400101]);
});

test('nobody tagged means nobody notified', () => {
  const plain: RichElement = { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'done' }] }] };
  assert.deepEqual(toTeamworkHtml(plain, resolve).notify, []);
});

test('someone with no Teamwork account is kept as text and reported, not dropped', () => {
  const stranger: RichElement = { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [
    { type: 'text', text: 'cc ' }, { type: 'user', user_id: 'U_CLIENT' },
  ] }] };
  const out = toTeamworkHtml(stranger, resolve, () => 'Sam Client');
  assert.match(out.html, /cc @Sam Client/);
  assert.ok(!out.html.includes('data-mention'), 'no fake mention link for someone Teamwork does not know');
  assert.deepEqual(out.unresolved, ['Sam Client']);
  assert.deepEqual(out.notify, []);
});

test('formatting carries through', () => {
  assert.match(toTeamworkHtml(reply, resolve).html, /<strong>thanks<\/strong>/);
});

test('lists, quotes and code become their HTML equivalents', () => {
  const rich: RichElement = { type: 'rich_text', elements: [
    { type: 'rich_text_list', style: 'bullet', elements: [
      { type: 'rich_text_section', elements: [{ type: 'text', text: 'one' }] },
      { type: 'rich_text_section', elements: [{ type: 'text', text: 'two' }] },
    ] },
    { type: 'rich_text_quote', elements: [{ type: 'text', text: 'quoted' }] },
    { type: 'rich_text_preformatted', elements: [{ type: 'text', text: 'npm test' }] },
  ] };
  const { html } = toTeamworkHtml(rich, resolve);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<blockquote>quoted<\/blockquote>/);
  assert.match(html, /<pre>npm test<\/pre>/);
});

test('what they typed is escaped, so it cannot turn into markup', () => {
  const rich: RichElement = { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [
    { type: 'text', text: '<script>alert(1)</script> & "x"' },
  ] }] };
  const { html } = toTeamworkHtml(rich, resolve);
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('a link keeps its address', () => {
  const rich: RichElement = { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [
    { type: 'link', url: 'https://github.com/pr/1', text: 'the PR' },
  ] }] };
  assert.match(toTeamworkHtml(rich, resolve).html, /<a href="https:\/\/github.com\/pr\/1" target="_blank">the PR<\/a>/);
});

test('an emoji arrives as the emoji, not its code', () => {
  const rich: RichElement = { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [
    { type: 'emoji', name: 'thumbsup', unicode: '1f44d' },
  ] }] };
  assert.match(toTeamworkHtml(rich, resolve).html, /👍/);
});

test('the people tagged are listed once each, in order', () => {
  const rich: RichElement = { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [
    { type: 'user', user_id: 'U2' }, { type: 'user', user_id: 'U1' }, { type: 'user', user_id: 'U2' },
  ] }] };
  assert.deepEqual(mentionedUsers(rich), ['U2', 'U1']);
});

test('plain text reads naturally, for telling an empty box from a real reply', () => {
  assert.equal(plainText(reply, () => 'Kiran'), 'Hi @Kiran, merged? thanks');
  assert.equal(plainText({ type: 'rich_text', elements: [] }), '');
});

// --- who a Slack user is in Teamwork -----------------------------------------------

const people = [
  { id: 400101, firstName: 'Kiran', lastName: 'menon', email: 'kiran@example.com' },
  { id: 400102, firstName: 'Arjun', lastName: 'Rao', email: 'arjunr@example.com' },
  { id: 400103, firstName: 'Arjun', lastName: 'Mehta', email: 'arjunm@example.com' },
  { id: 111, firstName: 'Priya', lastName: 'Singh', email: 'priya@other.com' },
  { id: 112, firstName: 'Priya', lastName: 'Singh', email: 'priya.s@other.com' },
];

test('a Slack user is matched to Teamwork by email', () => {
  assert.equal(matchPerson({ id: 'U1', email: 'ArjunR@example.com', realName: 'Arjun Kumar Rao' }, people)?.id, 400102);
});

test('with no email match, a unique full name is enough', () => {
  assert.equal(matchPerson({ id: 'U1', email: 'b@gmail.com', realName: 'Kiran Menon' }, people)?.id, 400101);
});

test('two people with the same name are never guessed between', () => {
  assert.equal(matchPerson({ id: 'U1', realName: 'Priya Singh' }, people), null);
});

test('a first name alone does not match — there are two Arjuns', () => {
  assert.equal(matchPerson({ id: 'U1', realName: 'Arjun' }, people), null);
});

test('the handles Teamwork really uses are read out of its own comment HTML', () => {
  const html = '<p>Hi <a href="/app/people/400104" rel="noopener noreferrer nofollow" data-mention="true" target="_blank">@NehaK</a> '
    + '<a href="https://example.com">@not-a-mention</a></p>';
  assert.deepEqual([...mentionHandlesFromHtml([html])], [[400104, 'NehaK']]);
});

test('a handle seen in a real comment beats one guessed from the name', () => {
  const omkar = { id: 9, firstName: 'Omkar', lastName: 'Kumar Tiwari' };
  assert.equal(handleFor(omkar, new Map()), 'OmkarK');
  assert.equal(handleFor(omkar, new Map([[9, 'OmkarKumarT']])), 'OmkarKumarT');
});

test('the guess follows the workspace pattern, lower-case surname initial and all', () => {
  assert.equal(handleFor(people[0]!, new Map()), 'Kiranm');
  assert.equal(handleFor(people[1]!, new Map()), 'ArjunR');
});
