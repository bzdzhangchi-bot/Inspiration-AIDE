import { Children, isValidElement, type ComponentPropsWithoutRef, useEffect, useMemo, useRef, useState } from 'react';
import hljs from 'highlight.js';
import mermaid from 'mermaid';
import ReactMarkdown from 'react-markdown';
import rehypeSlug from 'rehype-slug';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

let mermaidInitialized = false;
let mermaidRenderChain: Promise<void> = Promise.resolve();

function ensureMermaidInitialized() {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    suppressErrorRendering: true,
    theme: 'neutral',
    fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    htmlLabels: true,
    flowchart: {
      useMaxWidth: true
    },
    sequence: {
      useMaxWidth: true
    },
    gitGraph: {
      useMaxWidth: true
    }
  });
  mermaidInitialized = true;
}

type MermaidDiagramProps = {
  source: string;
};

function MermaidDiagram({ source }: MermaidDiagramProps) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [isRendering, setIsRendering] = useState(true);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const bindFunctionsRef = useRef<((element: Element) => void) | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    ensureMermaidInitialized();
    setError('');
    setIsRendering(true);
    bindFunctionsRef.current = undefined;

    mermaidRenderChain = mermaidRenderChain
      .catch(() => undefined)
      .then(async () => {
        try {
          await mermaid.parse(source, { suppressErrors: false });
          const renderId = `mermaid-preview-${Math.random().toString(36).slice(2, 10)}`;
          const rendered = await mermaid.render(renderId, source, canvasRef.current ?? undefined);
          if (cancelled) return;
          if (!rendered.svg || !rendered.svg.includes('<svg')) {
            throw new Error('Mermaid returned empty SVG output');
          }
          bindFunctionsRef.current = rendered.bindFunctions;
          setSvg(rendered.svg);
          setError('');
          setIsRendering(false);
        } catch (renderError) {
          if (cancelled) return;
          const message = renderError instanceof Error ? renderError.message : 'Failed to render Mermaid diagram';
          console.error('Mermaid preview render failed', renderError);
          bindFunctionsRef.current = undefined;
          setSvg('');
          setError(message);
          setIsRendering(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [source]);

  useEffect(() => {
    if (!svg || !canvasRef.current) return;
    const svgEl = canvasRef.current.querySelector<SVGSVGElement>('svg');
    if (svgEl) {
      svgEl.removeAttribute('width');
      svgEl.removeAttribute('height');
      svgEl.style.maxWidth = '100%';
      svgEl.style.height = 'auto';
      svgEl.style.display = 'block';
    }
    bindFunctionsRef.current?.(canvasRef.current);
  }, [svg]);

  return (
    <div
      className={`mermaidDiagram${svg ? ' isRendered' : ''}${error ? ' hasError' : ''}${isRendering ? ' isRendering' : ''}`}
      data-mermaid-error={error || undefined}
      title={error || undefined}
    >
      <div ref={canvasRef} className="mermaidCanvas" dangerouslySetInnerHTML={svg ? { __html: svg } : undefined} />
      <pre className="mermaidSource">
        <code className="language-mermaid">{source}</code>
      </pre>
    </div>
  );
}

type MarkdownCodeProps = ComponentPropsWithoutRef<'code'> & {
  node?: {
    tagName?: string;
    properties?: {
      className?: string[] | string;
    };
  };
};

type MarkdownParagraphProps = ComponentPropsWithoutRef<'p'>;
type MarkdownPreProps = ComponentPropsWithoutRef<'pre'>;
type MarkdownNode = {
  tagName?: string;
  properties?: {
    className?: string[] | string;
  };
  children?: Array<{
    type?: string;
    value?: string;
    tagName?: string;
    properties?: {
      className?: string[] | string;
    };
    children?: Array<{
      type?: string;
      value?: string;
    }>;
  }>;
};

function MarkdownParagraph({ children, ...props }: MarkdownParagraphProps) {
  const nodes = Children.toArray(children).filter((child) => {
    if (typeof child !== 'string') return true;
    return child.trim().length > 0;
  });
  if (
    nodes.length === 1
    && isValidElement(nodes[0])
    && typeof nodes[0].type === 'string'
    && nodes[0].type === 'code'
  ) {
    return <span {...props}>{children}</span>;
  }
  return <p {...props}>{children}</p>;
}

function MarkdownCode({ className, children, ...props }: MarkdownCodeProps) {
  return <code className={className} {...props}>{children}</code>;
}

function MarkdownPre({ children, ...props }: MarkdownPreProps & { node?: MarkdownNode }) {
  const codeNode = props.node?.children?.find((child) => child.tagName === 'code');
  if (!codeNode) {
    return <pre {...props}>{children}</pre>;
  }

  const className = Array.isArray(codeNode.properties?.className)
    ? codeNode.properties?.className.join(' ')
    : codeNode.properties?.className ?? '';
  const source = (codeNode.children ?? [])
    .map((child) => child.value ?? '')
    .join('')
    .replace(/\n$/, '');
  const language = className.match(/language-([^\s]+)/)?.[1]?.toLowerCase();
  const highlighted = useMemo(() => {
    if (!language) {
      return hljs.highlightAuto(source);
    }
    if (hljs.getLanguage(language)) {
      return hljs.highlight(source, { language });
    }
    return hljs.highlightAuto(source);
  }, [language, source]);

  if (language === 'mermaid') {
    return <MermaidDiagram source={source} />;
  }

  return (
    <pre {...props}>
      <code
        className={`hljs${highlighted.language ? ` language-${highlighted.language}` : ''}`}
        dangerouslySetInnerHTML={{ __html: highlighted.value }}
      />
    </pre>
  );
}

export default function MarkdownPreviewContent({
  markdown,
  onOpenFileLink
}: {
  markdown: string;
  onOpenFileLink?: (href: string) => void | Promise<void>;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      rehypePlugins={[rehypeSlug]}
      components={{
        p: MarkdownParagraph,
        pre: MarkdownPre,
        code: MarkdownCode,
        a({ href, children, ...props }) {
          const external = typeof href === 'string' && /^(https?:)?\/\//.test(href);
          const isHashLink = typeof href === 'string' && href.startsWith('#');
          return (
            <a
              href={href}
              target={external ? '_blank' : undefined}
              rel={external ? 'noreferrer noopener' : undefined}
              onClick={(event) => {
                props.onClick?.(event);
                if (event.defaultPrevented || !href || external || isHashLink || !onOpenFileLink) return;
                event.preventDefault();
                void onOpenFileLink(href);
              }}
              {...props}
            >
              {children}
            </a>
          );
        }
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}
