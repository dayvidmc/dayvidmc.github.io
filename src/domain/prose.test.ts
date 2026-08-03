import { describe, expect, it } from 'vitest';
import { firstParagraph, isSafeHref, parseInline, parseProse } from './prose';

/**
 * The tests that matter most here are the ones about links.
 *
 * Everything else in this file being wrong makes a page look untidy. The link
 * checks being wrong puts a script on the front page of a children's hospital
 * fundraiser, and the person who pasted it need not have meant anything by it.
 */

describe('what a link may point at', () => {
  it('allows the things a committee actually types', () => {
    expect(isSafeHref('https://cheo.on.ca')).toBe(true);
    expect(isSafeHref('http://example.com')).toBe(true);
    expect(isSafeHref('mailto:sponsors@example.com')).toBe(true);
    expect(isSafeHref('tel:+16135550100')).toBe(true);
    expect(isSafeHref('/schedule')).toBe(true);
    expect(isSafeHref('#top')).toBe(true);
  });

  it('refuses javascript, however it is dressed up', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('JavaScript:alert(1)')).toBe(false);
    // Control characters are how `java\nscript:` gets past a naive check.
    expect(isSafeHref('java\nscript:alert(1)')).toBe(false);
    expect(isSafeHref('java\tscript:alert(1)')).toBe(false);
    expect(isSafeHref(' javascript:alert(1)')).toBe(false);
  });

  it('refuses a data URL', () => {
    expect(isSafeHref('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
  });

  it('refuses a protocol-relative URL rather than reading it as a path', () => {
    // `//evil.example` looks like a path and is not one.
    expect(isSafeHref('//evil.example/steal')).toBe(false);
  });

  it('refuses nothing at all', () => {
    expect(isSafeHref('')).toBe(false);
    expect(isSafeHref('   ')).toBe(false);
  });
});

describe('a link in a page body', () => {
  it('becomes a link node when it is safe', () => {
    expect(parseInline('See [the schedule](/schedule) for times.')).toEqual([
      { type: 'text', value: 'See ' },
      { type: 'link', href: '/schedule', children: [{ type: 'text', value: 'the schedule' }] },
      { type: 'text', value: ' for times.' },
    ]);
  });

  it('keeps the words and drops the link when it is not', () => {
    // The sentence still reads. Nobody can be sent anywhere by it.
    expect(parseInline('Click [here](javascript:alert(1)) now')).toEqual([
      { type: 'text', value: 'Click here now' },
    ]);
  });

  it('handles a real URL with brackets in it', () => {
    // Stopping at the first `)` leaves a stray bracket in the sentence and a
    // link to half an address.
    const [node] = parseInline('[Baseball](https://en.wikipedia.org/wiki/Baseball_(ball))');
    expect(node).toEqual({
      type: 'link',
      href: 'https://en.wikipedia.org/wiki/Baseball_(ball)',
      children: [{ type: 'text', value: 'Baseball' }],
    });
  });

  it('leaves a bracket that is not a link alone', () => {
    expect(parseInline('[not a link] and (not a url)')).toEqual([
      { type: 'text', value: '[not a link] and (not a url)' },
    ]);
  });
});

describe('blocks', () => {
  it('reads a paragraph, joining wrapped lines', () => {
    expect(parseProse('One line\nand its continuation.')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: 'One line and its continuation.' }] },
    ]);
  });

  it('separates paragraphs on a blank line', () => {
    expect(parseProse('First.\n\nSecond.')).toHaveLength(2);
  });

  it('collapses every heading level to h2 or h3', () => {
    // The page supplies its own h1; a body that introduces a second one breaks
    // the outline a screen reader navigates by.
    const blocks = parseProse('# Top\n\n### Lower\n\n###### Lowest');
    expect(blocks.map((b) => (b.type === 'heading' ? b.level : null))).toEqual([2, 3, 3]);
  });

  it('reads a bulleted list', () => {
    const [block] = parseProse('- one\n- two');
    expect(block).toEqual({
      type: 'list',
      ordered: false,
      items: [[{ type: 'text', value: 'one' }], [{ type: 'text', value: 'two' }]],
    });
  });

  it('reads a numbered list', () => {
    const [block] = parseProse('1. one\n2. two');
    expect(block?.type === 'list' && block.ordered).toBe(true);
  });

  it('starts a new list when the kind changes', () => {
    const blocks = parseProse('- one\n1. two');
    expect(blocks).toHaveLength(2);
  });

  it('ends a list at a blank line', () => {
    const blocks = parseProse('- one\n\nA paragraph.');
    expect(blocks.map((b) => b.type)).toEqual(['list', 'paragraph']);
  });

  it('reads a rule', () => {
    expect(parseProse('---')).toEqual([{ type: 'rule' }]);
  });

  it('reads a quote', () => {
    const [block] = parseProse('> in memory of Scott');
    expect(block).toEqual({
      type: 'quote',
      children: [{ type: 'text', value: 'in memory of Scott' }],
    });
  });

  it('has nothing to say about nothing', () => {
    expect(parseProse('')).toEqual([]);
    expect(parseProse('\n\n   \n')).toEqual([]);
  });
});

describe('marks', () => {
  it('reads bold and italic', () => {
    expect(parseInline('**bold** and *italic*')).toEqual([
      { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
      { type: 'text', value: ' and ' },
      { type: 'em', children: [{ type: 'text', value: 'italic' }] },
    ]);
  });

  it('leaves an unclosed marker as the character somebody typed', () => {
    // Swallowing the rest of a sentence is a much worse failure than showing
    // one stray asterisk.
    expect(parseInline('2 * 3 = 6')).toEqual([{ type: 'text', value: '2 * 3 = 6' }]);
    expect(parseInline('**unclosed')).toEqual([{ type: 'text', value: '**unclosed' }]);
  });

  it('handles an apostrophe, which is in nearly every sentence here', () => {
    expect(parseInline("Scott's story")).toEqual([{ type: 'text', value: "Scott's story" }]);
  });
});

describe('the summary line', () => {
  it('takes the first paragraph', () => {
    expect(firstParagraph('# Heading\n\nThe first sentence.\n\nThe second.')).toBe(
      'The first sentence.',
    );
  });

  it('strips the marks', () => {
    expect(firstParagraph('A **bold** [link](/x).')).toBe('A bold link.');
  });

  it('truncates rather than running on', () => {
    const long = `${'word '.repeat(80)}end`;
    const summary = firstParagraph(long, 50);
    expect(summary.length).toBeLessThanOrEqual(50);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('says nothing when there is no prose', () => {
    expect(firstParagraph('# Only a heading')).toBe('');
  });
});
