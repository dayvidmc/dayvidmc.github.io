import { parseProse, type Block, type Inline } from '@/domain/prose';

/**
 * Editable page content, rendered as React elements.
 *
 * There is no `dangerouslySetInnerHTML` in this file and there must never be
 * one. The parser hands back a tree of known node types and this turns each
 * into an element — so a page body cannot introduce a tag, an attribute or a
 * script, whatever somebody pastes into the editor.
 *
 * External links get `rel="noreferrer"`, because a page the committee edits
 * will eventually link to a sponsor and a sponsor's site is not ours.
 */
export function Prose({ source }: { source: string }) {
  const blocks = parseProse(source);
  if (blocks.length === 0) return null;

  return (
    <div className="prose">
      {blocks.map((block, index) => (
        <BlockNode key={index} block={block} />
      ))}
    </div>
  );
}

function BlockNode({ block }: { block: Block }) {
  switch (block.type) {
    case 'heading':
      return block.level === 2 ? (
        <h2>
          <Inlines nodes={block.children} />
        </h2>
      ) : (
        <h3>
          <Inlines nodes={block.children} />
        </h3>
      );

    case 'paragraph':
      return (
        <p>
          <Inlines nodes={block.children} />
        </p>
      );

    case 'list':
      return block.ordered ? (
        <ol>
          {block.items.map((item, index) => (
            <li key={index}>
              <Inlines nodes={item} />
            </li>
          ))}
        </ol>
      ) : (
        <ul>
          {block.items.map((item, index) => (
            <li key={index}>
              <Inlines nodes={item} />
            </li>
          ))}
        </ul>
      );

    case 'quote':
      return (
        <blockquote>
          <Inlines nodes={block.children} />
        </blockquote>
      );

    case 'rule':
      return <hr />;
  }
}

function Inlines({ nodes }: { nodes: readonly Inline[] }) {
  return (
    <>
      {nodes.map((node, index) => (
        <InlineNode key={index} node={node} />
      ))}
    </>
  );
}

function InlineNode({ node }: { node: Inline }) {
  switch (node.type) {
    case 'text':
      return <>{node.value}</>;
    case 'strong':
      return (
        <strong>
          <Inlines nodes={node.children} />
        </strong>
      );
    case 'em':
      return (
        <em>
          <Inlines nodes={node.children} />
        </em>
      );
    case 'link': {
      const external = /^https?:/i.test(node.href);
      return (
        <a
          href={node.href}
          {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
        >
          <Inlines nodes={node.children} />
        </a>
      );
    }
  }
}
