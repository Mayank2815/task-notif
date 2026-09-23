import type { RenderedMessage } from './message.js';

/** Slack takes at most fifty blocks in one message. */
export const MESSAGE_BLOCKS = 50;
/** Kept free on every part for the "part 2 of 2" line and the "continued" line. */
const NOTE_ROOM = 2;

type Block = Record<string, unknown>;

/** A group heading drawn as a section: "💬  *Awaiting my response*  ·  2". */
const GROUP_HEADING = /\*[^*\n]+\*\s+·\s+\d+$/;

/** Blocks that introduce what follows, so a part never ends on one of them. */
function leadsNext(b: Block): boolean {
  if (b.type === 'header' || b.type === 'divider') return true;
  const text = (b.text as { text?: string } | undefined)?.text;
  return b.type === 'section' && !b.accessory && typeof text === 'string' && GROUP_HEADING.test(text);
}

/** Blocks that belong to the one before them: a row's buttons, or its metadata line. */
function belongsToPrevious(b: Block, prev: Block | undefined): boolean {
  if (!prev || prev.type !== 'section') return false;
  return b.type === 'actions' || b.type === 'context';
}

/**
 * The message cut into pieces that must stay whole: a row with its buttons and metadata,
 * and a heading with whatever comes first under it. A part boundary only ever falls
 * between two pieces, so no row is separated from its own controls.
 */
export function toUnits(blocks: Block[]): Block[][] {
  const units: Block[][] = [];
  let lead: Block[] = [];
  blocks.forEach((b, i) => {
    if (leadsNext(b)) { lead.push(b); return; }
    const last = units[units.length - 1];
    if (lead.length === 0 && last && belongsToPrevious(b, blocks[i - 1])) { last.push(b); return; }
    units.push([...lead, b]);
    lead = [];
  });
  if (lead.length) units.push(lead);
  return units;
}

const note = (text: string): Block => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

/**
 * A message that fits in one Slack message is returned untouched. One that does not is
 * sent as several, in order, rather than having its tail cut off.
 *
 * Trimming to the ceiling used to drop content silently: Friday 11 September's weekly lost
 * thirteen blocks for one person and six for another — whole sections nobody saw.
 */
export function paginate(rendered: RenderedMessage, max = MESSAGE_BLOCKS): RenderedMessage {
  const blocks = rendered.blocks as Block[];
  if (blocks.length <= max) return rendered;

  const room = max - NOTE_ROOM;
  const pages: Block[][] = [[]];
  for (const unit of toUnits(blocks)) {
    // A single piece larger than a whole part cannot stay whole; it is the only case cut.
    const chunks = unit.length > room
      ? Array.from({ length: Math.ceil(unit.length / room) }, (_, k) => unit.slice(k * room, (k + 1) * room))
      : [unit];
    for (const chunk of chunks) {
      const page = pages[pages.length - 1]!;
      if (page.length > 0 && page.length + chunk.length > room) pages.push([...chunk]);
      else page.push(...chunk);
    }
  }

  const total = pages.length;
  const parts = pages.map((page, i) => [
    ...(i > 0 ? [note(`_Part ${i + 1} of ${total}, continued_`)] : []),
    ...page,
    ...(i < total - 1 ? [note(`_Continued in the next message: part ${i + 2} of ${total}_`)] : []),
  ]);

  return {
    text: rendered.text,
    blocks: parts[0]!,
    ...(rendered.attachments ? { attachments: rendered.attachments } : {}),
    continuation: parts.slice(1).map((b, i) => ({ text: `${rendered.text} (part ${i + 2} of ${total})`, blocks: b })),
  };
}
