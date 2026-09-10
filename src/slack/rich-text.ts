/**
 * Slack's rich text, as a rich_text_input hands it back, turned into a Teamwork comment.
 *
 * The point of this is the mentions. Typing @ in the reply box gives the same people
 * picker as Slack's own message box, and each pick arrives as a user id. Teamwork stores
 * a real mention as a link to the person — exactly the markup its own editor writes:
 *
 *   <a href="/app/people/400102" data-mention="true">@ArjunR</a>
 *
 * Posting that markup, rather than the bare text "@ArjunR", is what makes it a mention
 * in Teamwork and not just a word that looks like one.
 */

export interface RichElement {
  type: string;
  text?: string;
  url?: string;
  user_id?: string;
  name?: string;
  unicode?: string;
  style?: { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean } | string;
  elements?: RichElement[];
}

/** Who a Slack mention turned out to be in Teamwork, or null when nobody matched. */
export type MentionResolver = (slackUserId: string) => { teamworkId: number; handle: string } | null;

const escHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Every Slack user id mentioned, in order, once each. */
export function mentionedUsers(root: RichElement | null | undefined): string[] {
  const out: string[] = [];
  const walk = (e: RichElement) => {
    if (e.type === 'user' && e.user_id && !out.includes(e.user_id)) out.push(e.user_id);
    e.elements?.forEach(walk);
  };
  if (root) walk(root);
  return out;
}

/** The words alone — enough to tell an empty box from a real reply. */
export function plainText(root: RichElement | null | undefined, names: (id: string) => string = (id) => id): string {
  const walk = (e: RichElement): string => {
    switch (e.type) {
      case 'text': return e.text ?? '';
      case 'user': return `@${names(e.user_id ?? '')}`;
      case 'link': return e.text || e.url || '';
      case 'emoji': return e.unicode ? fromUnicode(e.unicode) : `:${e.name}:`;
      case 'rich_text_list': return (e.elements ?? []).map((i) => `• ${walk(i)}`).join('\n');
      default: return (e.elements ?? []).map(walk).join(e.type === 'rich_text' ? '\n' : '');
    }
  };
  return root ? walk(root).trim() : '';
}

function fromUnicode(code: string): string {
  try {
    return String.fromCodePoint(...code.split('-').map((h) => parseInt(h, 16)));
  } catch {
    return '';
  }
}

function styled(html: string, style: RichElement['style']): string {
  if (!style || typeof style === 'string') return html;
  let out = html;
  if (style.code) out = `<code>${out}</code>`;
  if (style.bold) out = `<strong>${out}</strong>`;
  if (style.italic) out = `<em>${out}</em>`;
  if (style.strike) out = `<s>${out}</s>`;
  return out;
}

/**
 * The HTML Teamwork's own editor would have produced. Returns the unresolved mentions
 * too, so the person can be told who was not tagged rather than finding out later.
 */
export function toTeamworkHtml(
  root: RichElement | null | undefined,
  resolve: MentionResolver,
  slackName: (slackUserId: string) => string = (id) => id,
): { html: string; notify: number[]; unresolved: string[] } {
  const notify: number[] = [];
  const unresolved: string[] = [];

  const inline = (e: RichElement): string => {
    switch (e.type) {
      case 'text':
        return styled(escHtml(e.text ?? '').replace(/\n/g, '<br>'), e.style);
      case 'user': {
        const who = resolve(e.user_id ?? '');
        if (!who) {
          const name = slackName(e.user_id ?? '');
          if (!unresolved.includes(name)) unresolved.push(name);
          return escHtml(`@${name}`);
        }
        if (!notify.includes(who.teamworkId)) notify.push(who.teamworkId);
        return `<a href="/app/people/${who.teamworkId}" rel="noopener noreferrer nofollow" data-mention="true" target="_blank">@${escHtml(who.handle)}</a>`;
      }
      case 'link':
        return `<a href="${escHtml(e.url ?? '')}" target="_blank">${escHtml(e.text || e.url || '')}</a>`;
      case 'emoji':
        return e.unicode ? fromUnicode(e.unicode) : escHtml(`:${e.name}:`);
      case 'channel':
      case 'usergroup':
      case 'broadcast':
        // Slack-only ideas with no Teamwork equivalent; kept as readable text.
        return escHtml(e.type === 'broadcast' ? `@${e.name ?? 'here'}` : '@group');
      default:
        return (e.elements ?? []).map(inline).join('');
    }
  };

  const block = (e: RichElement): string => {
    switch (e.type) {
      case 'rich_text_section':
        return `<p>${inline(e)}</p>`;
      case 'rich_text_list': {
        const tag = e.style === 'ordered' ? 'ol' : 'ul';
        return `<${tag}>${(e.elements ?? []).map((i) => `<li>${inline(i)}</li>`).join('')}</${tag}>`;
      }
      case 'rich_text_quote':
        return `<blockquote>${inline(e)}</blockquote>`;
      case 'rich_text_preformatted':
        return `<pre>${inline(e)}</pre>`;
      default:
        return inline(e);
    }
  };

  const html = root ? (root.elements ?? []).map(block).join('') : '';
  return { html, notify, unresolved };
}
