import { type ComponentPropsWithoutRef, type DragEvent as ReactDragEvent, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import hljs from 'highlight.js';
import GithubSlugger from 'github-slugger';
import { marked } from 'marked';
import mermaid from 'mermaid';
import ReactMarkdown from 'react-markdown';
import rehypeSlug from 'rehype-slug';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { fsClient } from '../fsClient';
import { CORE_SERVER_URL, openAgentPatchStream, openInlineCompletionStream } from '../wsClient';
import type { ProviderId } from '../../shared/types';

type DirEntry = { name: string; path: string; kind: 'file' | 'dir' };
type WorkspaceFileState = { kind: 'text' | 'binary'; readOnly: boolean; size: number };
type OpenDoc = {
  path: string;
  name: string;
  text: string;
  binaryContents: string | null;
  contentsEncoding: 'utf8' | 'base64' | null;
  mimeType: string | null;
  fileState: WorkspaceFileState;
  dirty: boolean;
  viewMode: 'edit' | 'preview';
};
type MarkdownHeading = { id: string; text: string; level: number };
type JavaBuildTool = 'maven' | 'gradle' | 'plain';
type JavaProjectInfo = {
  enabled: boolean;
  buildTool: JavaBuildTool | null;
  hasWrapper: boolean;
  hasSourceLayout: boolean;
  hasTestLayout: boolean;
};
type ActiveJavaInfo = {
  packageName: string | null;
  typeName: string | null;
  hasMainMethod: boolean;
  hasTestMethods: boolean;
};

type WelcomeShortcutItem = {
  id: string;
  title: string;
  description: string;
  keys: string[];
  disabled?: boolean;
  run: () => void | Promise<void>;
};

let mermaidInitialized = false;
let mermaidRenderChain: Promise<void> = Promise.resolve();

const FILE_TYPE_LABELS: Record<string, string> = {
  ts: 'TS',
  tsx: 'TSX',
  js: 'JS',
  jsx: 'JSX',
  json: 'JSON',
  jsonc: 'JSONC',
  md: 'MD',
  mdx: 'MDX',
  py: 'PY',
  java: 'JAVA',
  go: 'GO',
  rs: 'RUST',
  css: 'CSS',
  scss: 'SCSS',
  html: 'HTML',
  xml: 'XML',
  yml: 'YAML',
  yaml: 'YAML',
  toml: 'TOML',
  sh: 'SHELL',
  sql: 'SQL',
  vue: 'VUE',
  svelte: 'SVELTE',
  astro: 'ASTRO',
  txt: 'TEXT'
};

type ExplorerFileIcon = {
  label: string;
  tone:
    | 'blue'
    | 'sky'
    | 'cyan'
    | 'green'
    | 'lime'
    | 'orange'
    | 'yellow'
    | 'red'
    | 'pink'
    | 'purple'
    | 'slate'
    | 'amber';
};

function getFileName(filePath: string) {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

function getWorkspaceRootName(rootPath: string) {
  return rootPath.split(/[\\/]/).filter(Boolean).pop() ?? rootPath;
}

function isPathInsideRoot(rootPath: string, filePath: string) {
  return filePath === rootPath || filePath.startsWith(`${rootPath}/`) || filePath.startsWith(`${rootPath}\\`);
}

function reorderRoots(rootPaths: string[], sourceRoot: string, targetRoot: string, placement: 'before' | 'after') {
  if (sourceRoot === targetRoot) return rootPaths;
  const nextRoots = [...rootPaths];
  const sourceIndex = nextRoots.indexOf(sourceRoot);
  const targetIndex = nextRoots.indexOf(targetRoot);
  if (sourceIndex === -1 || targetIndex === -1) return rootPaths;

  const [movedRoot] = nextRoots.splice(sourceIndex, 1);
  const adjustedTargetIndex = nextRoots.indexOf(targetRoot);
  const insertIndex = placement === 'after' ? adjustedTargetIndex + 1 : adjustedTargetIndex;
  nextRoots.splice(insertIndex, 0, movedRoot);
  return nextRoots;
}

function joinPathSegments(basePath: string, segments: string[]) {
  return segments.reduce((current, segment) => `${current.replace(/[\\/]$/, '')}/${segment}`, basePath);
}

function getFileTypeLabel(filePath: string | null) {
  if (!filePath) return 'TEXT';
  const name = getFileName(filePath);
  const lowerName = name.toLowerCase();
  if (lowerName === 'pom.xml') return 'MAVEN';
  if (lowerName === 'build.gradle' || lowerName === 'build.gradle.kts' || lowerName === 'settings.gradle' || lowerName === 'settings.gradle.kts') return 'GRADLE';
  if (lowerName === 'gradlew' || lowerName === 'mvnw') return 'WRAPPER';
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '';
  if (!ext && /^dockerfile$/i.test(name)) return 'DOCKER';
  return FILE_TYPE_LABELS[ext] ?? (ext ? ext.toUpperCase() : 'TEXT');
}

function getExplorerFileIcon(filePath: string): ExplorerFileIcon {
  const name = getFileName(filePath);
  const lowerName = name.toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '';

  if (lowerName === 'dockerfile') return { label: 'DK', tone: 'blue' };
  if (lowerName === 'package.json') return { label: 'NP', tone: 'red' };
  if (lowerName === 'tsconfig.json') return { label: 'TS', tone: 'blue' };
  if (lowerName === 'readme.md') return { label: 'MD', tone: 'sky' };
  if (lowerName === 'pom.xml') return { label: 'MV', tone: 'orange' };
  if (lowerName === 'build.gradle' || lowerName === 'build.gradle.kts' || lowerName === 'settings.gradle' || lowerName === 'settings.gradle.kts') {
    return { label: 'GR', tone: 'green' };
  }
  if (lowerName === 'gradlew' || lowerName === 'mvnw') return { label: 'SH', tone: 'slate' };

  switch (ext) {
    case 'ts':
      return { label: 'TS', tone: 'blue' };
    case 'tsx':
      return { label: 'TX', tone: 'sky' };
    case 'js':
      return { label: 'JS', tone: 'yellow' };
    case 'jsx':
      return { label: 'JX', tone: 'amber' };
    case 'json':
    case 'jsonc':
      return { label: '{}', tone: 'lime' };
    case 'md':
    case 'mdx':
    case 'markdown':
      return { label: 'MD', tone: 'sky' };
    case 'py':
      return { label: 'PY', tone: 'green' };
    case 'pdf':
      return { label: 'PDF', tone: 'red' };
    case 'java':
      return { label: 'JV', tone: 'orange' };
    case 'go':
      return { label: 'GO', tone: 'cyan' };
    case 'rs':
      return { label: 'RS', tone: 'slate' };
    case 'css':
      return { label: 'CS', tone: 'blue' };
    case 'scss':
      return { label: 'SC', tone: 'pink' };
    case 'html':
      return { label: '</>', tone: 'orange' };
    case 'xml':
      return { label: 'XM', tone: 'amber' };
    case 'yml':
    case 'yaml':
      return { label: 'YM', tone: 'purple' };
    case 'toml':
      return { label: 'TM', tone: 'slate' };
    case 'sh':
      return { label: '$', tone: 'slate' };
    case 'sql':
      return { label: 'DB', tone: 'red' };
    case 'vue':
      return { label: 'VU', tone: 'green' };
    case 'svelte':
      return { label: 'SV', tone: 'orange' };
    case 'astro':
      return { label: 'AS', tone: 'purple' };
    case 'txt':
      return { label: 'TX', tone: 'slate' };
    default:
      return { label: '?', tone: 'slate' };
  }
}

function getWelcomeFilePriority(entry: DirEntry) {
  const lowerName = entry.name.toLowerCase();
  if (lowerName === 'readme.md') return 100;
  if (lowerName === 'package.json') return 95;
  if (lowerName === 'pom.xml') return 92;
  if (lowerName === 'build.gradle' || lowerName === 'build.gradle.kts') return 90;
  if (lowerName === 'vite.config.ts') return 88;
  if (lowerName === 'index.html') return 86;
  if (lowerName.startsWith('tsconfig')) return 84;
  if (entry.kind === 'file') return 60;
  return 10;
}

function formatShortcutLabel(keys: string[], isMacLike: boolean) {
  const mapped = keys.map((key) => {
    if (key === 'Mod') return isMacLike ? '⌘' : 'Ctrl';
    if (key === 'Shift') return isMacLike ? '⇧' : 'Shift';
    if (key === 'Alt') return isMacLike ? '⌥' : 'Alt';
    return key.toUpperCase();
  });
  return mapped.join(isMacLike ? ' ' : ' + ');
}

function isMarkdownFile(filePath: string | null) {
  if (!filePath) return false;
  const lower = getFileName(filePath).toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.mdx') || lower.endsWith('.markdown');
}

function isPdfFile(filePath: string | null) {
  if (!filePath) return false;
  return getFileName(filePath).toLowerCase().endsWith('.pdf');
}

function isHtmlFile(filePath: string | null) {
  if (!filePath) return false;
  const lower = getFileName(filePath).toLowerCase();
  return lower.endsWith('.html') || lower.endsWith('.htm');
}

function toWorkspaceRelativePath(workspaceRoot: string, absoluteOrRelativePath: string) {
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const target = absoluteOrRelativePath.replace(/\\/g, '/');
  if (target === root) return '.';
  if (target.startsWith(`${root}/`)) {
    return target.slice(root.length + 1);
  }
  return target.replace(/^\/+/, '');
}

function encodeWorkspacePreviewToken(value: string) {
  const encoded = btoa(unescape(encodeURIComponent(value)));
  return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function encodePreviewPath(pathValue: string) {
  return pathValue.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function buildWorkspacePreviewRootUrl(workspaceRoot: string) {
  const rootToken = encodeWorkspacePreviewToken(workspaceRoot);
  return `${CORE_SERVER_URL}/workspace-preview/${rootToken}`;
}

function buildWorkspacePreviewBaseUrl(workspaceRoot: string, filePath: string) {
  const relativePath = toWorkspaceRelativePath(workspaceRoot, filePath);
  const relativeDir = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/') + 1) : '';
  const encodedDir = encodePreviewPath(relativeDir);
  return encodedDir
    ? `${buildWorkspacePreviewRootUrl(workspaceRoot)}/${encodedDir}`
    : `${buildWorkspacePreviewRootUrl(workspaceRoot)}/`;
}

function escapeHtmlAttribute(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function injectBaseHrefIntoHtml(html: string, baseHref: string) {
  const baseTag = `<base href="${escapeHtmlAttribute(baseHref)}">`;
  if (/<base\s/i.test(html)) {
    return html;
  }
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`);
  }
  return `<!doctype html><html><head>${baseTag}</head><body>${html}</body></html>`;
}

function rewriteRootRelativeHtmlUrls(html: string, workspaceRoot: string) {
  const previewRootUrl = buildWorkspacePreviewRootUrl(workspaceRoot);
  return html.replace(/\b(src|href|action|poster)=(['"])(\/[^'"#?]+(?:[?#][^'"]*)?)\2/gi, (_match, attr, quote, url) => {
    const rewritten = `${previewRootUrl}/${encodePreviewPath(url.slice(1))}`;
    return `${attr}=${quote}${rewritten}${quote}`;
  });
}

function isLikelyViteSourceHtml(html: string) {
  return /@vite\/client|<script[^>]+type=['"]module['"][^>]+src=['"]\/src\//i.test(html);
}

function buildViteSourcePreviewNotice(filePath: string, workspaceRoot: string | null) {
  const distHint = workspaceRoot && (filePath === `${workspaceRoot}/index.html` || filePath === `${workspaceRoot}\\index.html`)
    ? 'Try previewing dist/index.html after running the project build, or open the app through the Vite dev server.'
    : 'This file looks like a Vite source entry page. Preview the built output or run the Vite dev server instead.';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>HTML Preview Unavailable</title>
    <style>
      body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f7; color: #1f2328; }
      .previewNotice { max-width: 720px; margin: 48px auto; padding: 24px 28px; border-radius: 18px; background: #fff; box-shadow: 0 18px 44px rgba(15, 23, 42, 0.12); }
      h1 { margin: 0 0 12px; font-size: 22px; }
      p { margin: 0 0 10px; line-height: 1.6; }
      code { padding: 2px 6px; border-radius: 6px; background: #f1f3f5; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    </style>
  </head>
  <body>
    <div class="previewNotice">
      <h1>Static preview is not available for this HTML entry</h1>
      <p><code>${escapeHtml(filePath)}</code> references source modules that require the Vite toolchain at runtime.</p>
      <p>${escapeHtml(distHint)}</p>
    </div>
  </body>
</html>`;
}

function buildHtmlPreviewDocument(html: string, workspaceRoot: string, filePath: string) {
  if (isLikelyViteSourceHtml(html)) {
    return buildViteSourcePreviewNotice(filePath, workspaceRoot);
  }

  const rewrittenHtml = rewriteRootRelativeHtmlUrls(html, workspaceRoot);
  return injectBaseHrefIntoHtml(rewrittenHtml, buildWorkspacePreviewBaseUrl(workspaceRoot, filePath));
}

function slugifyHeading(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fa5\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-') || 'section';
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function decodeBase64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function extractMarkdownHeadings(markdown: string) {
  const headings: MarkdownHeading[] = [];
  const slugger = new GithubSlugger();
  const tokens = marked.lexer(markdown, { breaks: true, gfm: true }) as Array<{ type?: string; text?: string; depth?: number }>;

  for (const token of tokens) {
    if (token.type !== 'heading') continue;
    const text = token.text?.trim() ?? '';
    if (!text) continue;
    const id = slugger.slug(text || slugifyHeading(text));
    headings.push({
      id,
      text,
      level: token.depth ?? 1
    });
  }

  return headings;
}

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
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const bindFunctionsRef = useRef<((element: Element) => void) | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    ensureMermaidInitialized();
    setSvg('');
    setError('');
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
        } catch (renderError) {
          if (cancelled) return;
          const message = renderError instanceof Error ? renderError.message : 'Failed to render Mermaid diagram';
          console.error('Mermaid preview render failed', renderError);
          bindFunctionsRef.current = undefined;
          setSvg('');
          setError(message);
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
      className={`mermaidDiagram${svg ? ' isRendered' : ''}${error ? ' hasError' : ''}`}
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
  inline?: boolean;
};

function MarkdownCode({ inline, className, children, ...props }: MarkdownCodeProps) {
  const source = String(children ?? '').replace(/\n$/, '');
  const language = className?.match(/language-([^\s]+)/)?.[1]?.toLowerCase();
  const highlighted = useMemo(() => {
    if (!language) {
      return hljs.highlightAuto(source);
    }
    if (hljs.getLanguage(language)) {
      return hljs.highlight(source, { language });
    }
    return hljs.highlightAuto(source);
  }, [language, source]);

  if (inline) {
    return <code className={className} {...props}>{children}</code>;
  }

  if (language === 'mermaid') {
    return <MermaidDiagram source={source} />;
  }

  return (
    <pre>
      <code
        {...props}
        className={`hljs${highlighted.language ? ` language-${highlighted.language}` : ''}`}
        dangerouslySetInnerHTML={{ __html: highlighted.value }}
      />
    </pre>
  );
}

function MarkdownPreviewContent({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      rehypePlugins={[rehypeSlug]}
      components={{
        pre({ children }) {
          return <>{children}</>;
        },
        code: MarkdownCode,
        a({ href, children, ...props }) {
          const external = typeof href === 'string' && /^(https?:)?\/\//.test(href);
          return (
            <a
              href={href}
              target={external ? '_blank' : undefined}
              rel={external ? 'noreferrer noopener' : undefined}
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

function isJavaFile(filePath: string | null) {
  return !!filePath && getFileName(filePath).toLowerCase().endsWith('.java');
}

function analyzeJavaDocument(doc: OpenDoc | null): ActiveJavaInfo | null {
  if (!doc || doc.fileState.kind !== 'text' || !isJavaFile(doc.path)) return null;
  const packageMatch = doc.text.match(/^\s*package\s+([\w.]+)\s*;/m);
  const typeMatch = doc.text.match(/^\s*(?:public\s+)?(?:final\s+|abstract\s+)?(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/m);
  const hasMainMethod = /public\s+static\s+void\s+main\s*\(\s*String(?:\s*\[\s*\]|\s*\.\.\.)/m.test(doc.text);
  const hasTestMethods = /@Test\b|org\.junit|junit\.framework/m.test(doc.text);
  return {
    packageName: packageMatch?.[1] ?? null,
    typeName: typeMatch?.[1] ?? null,
    hasMainMethod,
    hasTestMethods
  };
}

function detectJavaProject(rootEntries: DirEntry[], activeDoc: OpenDoc | null, activeJavaInfo: ActiveJavaInfo | null): JavaProjectInfo {
  const names = new Set(rootEntries.map((entry) => entry.name.toLowerCase()));
  const hasMaven = names.has('pom.xml') || names.has('mvnw');
  const hasGradle = names.has('build.gradle') || names.has('build.gradle.kts') || names.has('settings.gradle') || names.has('settings.gradle.kts') || names.has('gradlew');
  const hasJavaFileAtRoot = rootEntries.some((entry) => entry.kind === 'file' && entry.name.toLowerCase().endsWith('.java'));
  const hasSourceLayout = names.has('src') || activeDoc?.path.includes('/src/main/java/') || activeDoc?.path.includes('\\src\\main\\java\\') || false;
  const hasTestLayout = activeDoc?.path.includes('/src/test/java/') || activeDoc?.path.includes('\\src\\test\\java\\') || false;

  if (hasMaven) {
    return {
      enabled: true,
      buildTool: 'maven',
      hasWrapper: names.has('mvnw'),
      hasSourceLayout,
      hasTestLayout
    };
  }

  if (hasGradle) {
    return {
      enabled: true,
      buildTool: 'gradle',
      hasWrapper: names.has('gradlew'),
      hasSourceLayout,
      hasTestLayout
    };
  }

  if (activeJavaInfo || hasJavaFileAtRoot) {
    return {
      enabled: true,
      buildTool: 'plain',
      hasWrapper: false,
      hasSourceLayout,
      hasTestLayout
    };
  }

  return {
    enabled: false,
    buildTool: null,
    hasWrapper: false,
    hasSourceLayout: false,
    hasTestLayout: false
  };
}

export type WorkspacePanelContext = {
  workspaceRoot: string | null;
  activePath: string | null;
  activeText: string;
  activeFileName: string | null;
  topLevelEntries: Array<{ path: string; name: string; kind: 'file' | 'dir' }>;
  pendingPatchCount: number;
  agentStatus: string;
  dirty: boolean;
  javaProject: {
    enabled: boolean;
    buildTool: JavaBuildTool | null;
    hasWrapper: boolean;
    packageName: string | null;
    typeName: string | null;
    hasMainMethod: boolean;
    hasTestMethods: boolean;
  };
};

export type WorkspacePanelHandle = {
  requestAgentPatch: (task?: string) => Promise<boolean>;
  applyAgentPatches: () => Promise<boolean>;
  syncExternalWrite: (filePath: string, contents: string) => Promise<void>;
  openWorkspaceFile: (filePath: string, options?: { reveal?: boolean }) => Promise<boolean>;
  revealWorkspaceFile: (filePath: string) => Promise<boolean>;
};

export const WorkspacePanel = forwardRef<WorkspacePanelHandle, {
  settings: {
    providerId: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    inlineCompletionsEnabled: boolean;
    agentPatchesEnabled: boolean;
  };
  onContextChange?: (context: WorkspacePanelContext) => void;
  onRunCommandInTerminal?: (command: string, timeoutMs?: number) => Promise<unknown>;
}>(function WorkspacePanel(props, ref) {
  const { settings } = props;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const editorOverlayRef = useRef<HTMLPreElement | null>(null);
  const previewBodyRef = useRef<HTMLDivElement | null>(null);
  const inlineStreamRef = useRef<{ close: () => void } | null>(null);
  const agentStreamRef = useRef<{ close: () => void } | null>(null);
  const splitDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const workspaceRootRef = useRef<string | null>(null);
  const expandedDirsRef = useRef<string[]>([]);
  const openDocsRef = useRef<OpenDoc[]>([]);
  const refreshTimerRef = useRef<number | null>(null);

  const [suggestionText, setSuggestionText] = useState<string>('');
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [suggestionError, setSuggestionError] = useState<string>('');

  const [agentStatus, setAgentStatus] = useState<string>('');
  const [agentPatches, setAgentPatches] = useState<
    Array<{ operation: 'modify' | 'create' | 'delete'; filePath: string; newText?: string }>
  >([]);
  const [workspaceRoots, setWorkspaceRoots] = useState<string[]>([]);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [rootEntriesByRoot, setRootEntriesByRoot] = useState<Record<string, DirEntry[]>>({});
  const [collapsedWorkspaceRoots, setCollapsedWorkspaceRoots] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('workspaceCollapsedRoots');
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  });
  const [treeEntries, setTreeEntries] = useState<Record<string, DirEntry[]>>({});
  const [expandedDirs, setExpandedDirs] = useState<string[]>([]);
  const [loadingDirs, setLoadingDirs] = useState<string[]>([]);
  const [openDocs, setOpenDocs] = useState<OpenDoc[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const [rootMenuOpenFor, setRootMenuOpenFor] = useState<string | null>(null);
  const [draggedRoot, setDraggedRoot] = useState<string | null>(null);
  const [dragOverRoot, setDragOverRoot] = useState<{ root: string; placement: 'before' | 'after' } | null>(null);
  const [explorerWidth, setExplorerWidth] = useState(() => {
    const raw = Number(localStorage.getItem('workspaceExplorerWidth'));
    return Number.isFinite(raw) && raw >= 200 ? raw : 280;
  });
  const [isExplorerCollapsed, setIsExplorerCollapsed] = useState(() => localStorage.getItem('workspaceExplorerCollapsed') === '1');
  const [activePdfUrl, setActivePdfUrl] = useState<string | null>(null);
  const [flashFilePath, setFlashFilePath] = useState<string | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const isMacLike = useMemo(() => /Mac|iPhone|iPad|iPod/i.test(navigator.platform), []);

  const rootEntries = useMemo(() => (workspaceRoot ? rootEntriesByRoot[workspaceRoot] ?? [] : []), [rootEntriesByRoot, workspaceRoot]);
  const activeDoc = useMemo(() => openDocs.find((doc) => doc.path === activePath) ?? null, [activePath, openDocs]);
  const activeText = activeDoc?.text ?? '';
  const dirty = activeDoc?.dirty ?? false;
  const activeJavaInfo = useMemo(() => analyzeJavaDocument(activeDoc), [activeDoc]);
  const javaProjectInfo = useMemo(() => detectJavaProject(rootEntries, activeDoc, activeJavaInfo), [activeDoc, activeJavaInfo, rootEntries]);
  const javaEditorHighlight = useMemo(() => {
    if (!activeDoc || activeDoc.fileState.kind !== 'text' || activeDoc.viewMode !== 'edit' || !isJavaFile(activeDoc.path)) {
      return '';
    }

    const source = activeDoc.text.length ? activeDoc.text : ' ';
    try {
      const highlighted = hljs.highlight(source, { language: 'java' }).value;
      return activeDoc.text.endsWith('\n') ? `${highlighted}\n ` : highlighted;
    } catch {
      return escapeHtml(source);
    }
  }, [activeDoc]);

  useEffect(() => {
    workspaceRootRef.current = workspaceRoot;
  }, [workspaceRoot]);

  useEffect(() => {
    if (!activeDoc || !isPdfFile(activeDoc.path) || activeDoc.contentsEncoding !== 'base64' || !activeDoc.binaryContents) {
      setActivePdfUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
      return;
    }

    try {
      const pdfBlob = new Blob([decodeBase64ToBytes(activeDoc.binaryContents)], {
        type: activeDoc.mimeType ?? 'application/pdf'
      });
      const nextUrl = URL.createObjectURL(pdfBlob);
      setActivePdfUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return nextUrl;
      });

      return () => {
        URL.revokeObjectURL(nextUrl);
      };
    } catch (error) {
      console.error('Failed to prepare PDF preview', error);
      setActivePdfUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
    }
  }, [activeDoc]);

  useEffect(() => {
    expandedDirsRef.current = expandedDirs;
  }, [expandedDirs]);

  useEffect(() => {
    openDocsRef.current = openDocs;
  }, [openDocs]);

  useEffect(() => {
    props.onContextChange?.({
      workspaceRoot,
      activePath,
      activeText,
      activeFileName: activePath ? getFileName(activePath) : null,
      topLevelEntries: rootEntries,
      pendingPatchCount: agentPatches.length,
      agentStatus,
      dirty,
      javaProject: {
        enabled: javaProjectInfo.enabled,
        buildTool: javaProjectInfo.buildTool,
        hasWrapper: javaProjectInfo.hasWrapper,
        packageName: activeJavaInfo?.packageName ?? null,
        typeName: activeJavaInfo?.typeName ?? null,
        hasMainMethod: activeJavaInfo?.hasMainMethod ?? false,
        hasTestMethods: activeJavaInfo?.hasTestMethods ?? false
      }
    });
  }, [activeJavaInfo, activePath, activeText, agentPatches.length, agentStatus, dirty, javaProjectInfo, props, rootEntries, workspaceRoot]);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
      inlineStreamRef.current?.close();
      agentStreamRef.current?.close();
      inlineStreamRef.current = null;
      agentStreamRef.current = null;
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    localStorage.setItem('workspaceExplorerWidth', String(explorerWidth));
  }, [explorerWidth]);

  useEffect(() => {
    localStorage.setItem('workspaceExplorerCollapsed', isExplorerCollapsed ? '1' : '0');
  }, [isExplorerCollapsed]);

  useEffect(() => {
    localStorage.setItem('workspaceCollapsedRoots', JSON.stringify(collapsedWorkspaceRoots));
  }, [collapsedWorkspaceRoots]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest('.workspaceRootMenuAnchor')) return;
      setRootMenuOpenFor(null);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setRootMenuOpenFor(null);
      }
    }

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  useEffect(() => {
    function onPointerMove(ev: PointerEvent) {
      const drag = splitDragRef.current;
      if (!drag) return;
      const nextWidth = Math.max(200, Math.min(520, drag.startWidth + (ev.clientX - drag.startX)));
      setExplorerWidth(nextWidth);
    }

    function onPointerUp() {
      splitDragRef.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, []);

  const canSave = useMemo(() => {
    return !!workspaceRoot && !!activeDoc && activeDoc.dirty && activeDoc.fileState.kind === 'text' && !activeDoc.fileState.readOnly;
  }, [activeDoc, workspaceRoot]);
  const dirtyDocCount = useMemo(() => openDocs.filter((doc) => doc.dirty && doc.fileState.kind === 'text' && !doc.fileState.readOnly).length, [openDocs]);
  const canTogglePreview = useMemo(() => {
    return !!activeDoc && activeDoc.fileState.kind === 'text' && (isMarkdownFile(activeDoc.path) || isHtmlFile(activeDoc.path));
  }, [activeDoc]);
  const welcomeQuickOpenEntries = useMemo(() => {
    return rootEntries
      .filter((entry) => entry.kind === 'file')
      .sort((left, right) => {
        const scoreDiff = getWelcomeFilePriority(right) - getWelcomeFilePriority(left);
        if (scoreDiff !== 0) return scoreDiff;
        return left.name.localeCompare(right.name);
      })
      .slice(0, 5);
  }, [rootEntries]);

  const activeFileType = useMemo(() => getFileTypeLabel(activePath), [activePath]);
  const activeWorkspaceRootName = useMemo(() => (workspaceRoot ? getWorkspaceRootName(workspaceRoot) : null), [workspaceRoot]);
  const markdownPreview = useMemo(() => {
    if (!activeDoc || !isMarkdownFile(activeDoc.path) || activeDoc.fileState.kind !== 'text') {
      return { headings: [] as MarkdownHeading[] };
    }
    return { headings: extractMarkdownHeadings(activeDoc.text) };
  }, [activeDoc]);
  const activeHtmlPreview = useMemo(() => {
    if (!activeDoc || !isHtmlFile(activeDoc.path) || activeDoc.fileState.kind !== 'text') {
      return { srcDoc: null as string | null };
    }

    const containingRoot = workspaceRoots.find((root) => activeDoc.path === root || activeDoc.path.startsWith(`${root}/`) || activeDoc.path.startsWith(`${root}\\`))
      ?? workspaceRoot;
    if (!containingRoot) {
      return { srcDoc: null };
    }

    return { srcDoc: buildHtmlPreviewDocument(activeDoc.text, containingRoot, activeDoc.path) };
  }, [activeDoc, workspaceRoot, workspaceRoots]);

  const findWorkspaceRootForPath = useCallback((filePath: string | null) => {
    if (!filePath) return null;
    return [...workspaceRoots]
      .sort((a, b) => b.length - a.length)
      .find((root) => filePath === root || filePath.startsWith(`${root}/`) || filePath.startsWith(`${root}\\`)) ?? null;
  }, [workspaceRoots]);

  const refreshList = useCallback(async (root: string) => {
    const items = await fsClient.listWorkspaceDir(root);
    items.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    setRootEntriesByRoot((prev) => ({ ...prev, [root]: items }));
    setStatus('');
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [roots, activeRoot] = await Promise.all([fsClient.getWorkspaceRoots(), fsClient.getWorkspaceRoot()]);
        if (cancelled) return;
        const nextRoots = roots.length ? roots : activeRoot ? [activeRoot] : [];
        setWorkspaceRoots(nextRoots);
        setWorkspaceRoot(activeRoot ?? nextRoots[0] ?? null);
        await Promise.all(nextRoots.map((root) => refreshList(root)));
      } catch (error) {
        if (cancelled) return;
        setStatus(error instanceof Error ? error.message : 'Failed to load workspace');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshList]);

  const sortEntries = useCallback((items: DirEntry[]) => {
    return [...items].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, []);

  const refreshExplorerIncremental = useCallback(async (root: string) => {
    const nextRootEntries = sortEntries(await fsClient.listWorkspaceDir(root));
    setRootEntriesByRoot((prev) => ({ ...prev, [root]: nextRootEntries }));

    const expanded = expandedDirsRef.current;
    if (!expanded.length) return;

    const loadedChildren = await Promise.all(expanded.map(async (dirPath) => {
      try {
        const items = sortEntries(await fsClient.listWorkspaceDir(dirPath));
        return { dirPath, items };
      } catch {
        return { dirPath, items: [] as DirEntry[] };
      }
    }));

    setTreeEntries((prev) => {
      const next = { ...prev };
      for (const entry of loadedChildren) {
        next[entry.dirPath] = entry.items;
      }
      return next;
    });
  }, [sortEntries]);

  const ensureFileVisible = useCallback(async (filePath: string | null) => {
    const root = findWorkspaceRootForPath(filePath);
    if (!root || !filePath) return;

    const relativePath = filePath.slice(root.length).replace(/^[/\\]/, '');
    if (!relativePath) return;

    const parts = relativePath.split(/[\\/]/).filter(Boolean);
    if (parts.length <= 1) return;

    const ancestorDirs: string[] = [];
    for (let index = 0; index < parts.length - 1; index += 1) {
      ancestorDirs.push(joinPathSegments(root, parts.slice(0, index + 1)));
    }

    try {
      const loadedEntries: Record<string, DirEntry[]> = {};
      for (const dirPath of ancestorDirs) {
        loadedEntries[dirPath] = sortEntries(await fsClient.listWorkspaceDir(dirPath));
      }

      setTreeEntries((prev) => ({ ...prev, ...loadedEntries }));
      setExpandedDirs((prev) => Array.from(new Set([...prev, ...ancestorDirs])));
    } catch {
      // Ignore reveal failures; opening the editor should still succeed.
    }
  }, [findWorkspaceRootForPath, sortEntries]);

  const flashExplorerFile = useCallback((filePath: string) => {
    setFlashFilePath(filePath);
    if (flashTimerRef.current !== null) {
      window.clearTimeout(flashTimerRef.current);
    }
    flashTimerRef.current = window.setTimeout(() => {
      setFlashFilePath((current) => (current === filePath ? null : current));
      flashTimerRef.current = null;
    }, 1400);
  }, []);

  const revealFileInExplorer = useCallback(async (filePath: string | null) => {
    if (!filePath) return false;
    const root = findWorkspaceRootForPath(filePath);
    if (root) {
      if (root !== workspaceRoot) {
        setWorkspaceRoot(root);
        try {
          await fsClient.setActiveWorkspaceRoot(root);
        } catch (error) {
          setStatus(error instanceof Error ? error.message : 'Failed to activate project');
          return false;
        }
      }
      setCollapsedWorkspaceRoots((prev) => prev.filter((item) => item !== root));
    }
    if (isExplorerCollapsed) {
      setIsExplorerCollapsed(false);
    }

    await ensureFileVisible(filePath);
    requestAnimationFrame(() => {
      const selector = `[data-file-path="${CSS.escape(filePath)}"]`;
      const target = document.querySelector<HTMLElement>(selector);
      target?.scrollIntoView({ block: 'center' });
      flashExplorerFile(filePath);
    });
    return true;
  }, [ensureFileVisible, findWorkspaceRootForPath, flashExplorerFile, isExplorerCollapsed, workspaceRoot]);

  const revealCurrentFile = useCallback(async () => {
    await revealFileInExplorer(activePath);
  }, [activePath, revealFileInExplorer]);

  const refreshOpenDocsFromDisk = useCallback(async () => {
    const docs = openDocsRef.current;
    const cleanDocs = docs.filter((doc) => !doc.dirty);
    if (!cleanDocs.length) return;

    const refreshed = await Promise.all(cleanDocs.map(async (doc) => {
      try {
        const file = await fsClient.readWorkspaceFile(doc.path);
        return {
          path: doc.path,
          text: file.kind === 'text' ? file.contents ?? '' : '',
          binaryContents: file.kind === 'binary' ? file.contents : null,
          contentsEncoding: file.contentsEncoding,
          mimeType: file.mimeType,
          fileState: { kind: file.kind, readOnly: file.readOnly, size: file.size }
        };
      } catch {
        return {
          path: doc.path,
          missing: true
        } as const;
      }
    }));

    setOpenDocs((prev) => prev.flatMap((doc) => {
      const nextState = refreshed.find((item) => item?.path === doc.path);
      if (!nextState) return [doc];
      if ('missing' in nextState) {
        return doc.dirty ? [doc] : [];
      }
      return [{
        ...doc,
        text: nextState.text,
        binaryContents: nextState.binaryContents,
        contentsEncoding: nextState.contentsEncoding,
        mimeType: nextState.mimeType,
        dirty: false,
        fileState: nextState.fileState
      }];
    }));
  }, []);

  const scheduleWorkspaceRefresh = useCallback((root: string, reason?: string) => {
    if (reason) {
      setStatus(reason);
    }
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      if (!root) return;
      void refreshExplorerIncremental(root)
        .then(() => refreshOpenDocsFromDisk())
        .then(() => {
          setStatus('');
        })
        .catch((error) => {
          setStatus(error instanceof Error ? error.message : 'Failed to refresh workspace');
        });
    }, 180);
  }, [refreshExplorerIncremental, refreshOpenDocsFromDisk]);

  const activateWorkspaceRoot = useCallback(async (root: string) => {
    setWorkspaceRoot(root);
    setRootMenuOpenFor(null);
    try {
      await fsClient.setActiveWorkspaceRoot(root);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to activate project');
    }
  }, []);

  const removeWorkspaceRoot = useCallback(async (root: string) => {
    try {
      const currentDocs = openDocsRef.current;
      const nextDocs = currentDocs.filter((doc) => !isPathInsideRoot(root, doc.path));
      const result = await fsClient.removeWorkspaceRoot(root);

      setRootMenuOpenFor(null);
      setWorkspaceRoots(result.workspaceRoots);
      setWorkspaceRoot(result.workspaceRoot);
      setRootEntriesByRoot((prev) => {
        const next = { ...prev };
        delete next[root];
        return next;
      });
      setCollapsedWorkspaceRoots((prev) => prev.filter((item) => item !== root));
      setExpandedDirs((prev) => prev.filter((dirPath) => !isPathInsideRoot(root, dirPath)));
      setLoadingDirs((prev) => prev.filter((dirPath) => !isPathInsideRoot(root, dirPath)));
      setTreeEntries((prev) => Object.fromEntries(Object.entries(prev).filter(([dirPath]) => !isPathInsideRoot(root, dirPath))));
      setOpenDocs(nextDocs);
      setActivePath((prev) => (prev && isPathInsideRoot(root, prev) ? nextDocs.at(-1)?.path ?? null : prev));
      setStatus('');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to remove project');
    }
  }, []);

  const persistWorkspaceRoots = useCallback(async (nextRoots: string[]) => {
    try {
      const result = await fsClient.setWorkspaceRoots(nextRoots);
      setWorkspaceRoots(result.workspaceRoots);
      setWorkspaceRoot(result.workspaceRoot);
      setStatus('');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to reorder projects');
    }
  }, []);

  const toggleWorkspaceRootSection = useCallback((root: string) => {
    setRootMenuOpenFor(null);
    setCollapsedWorkspaceRoots((prev) => prev.includes(root) ? prev.filter((item) => item !== root) : [...prev, root]);
  }, []);

  const onWorkspaceRootDragStart = useCallback((event: ReactDragEvent<HTMLButtonElement>, root: string) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', root);
    setDraggedRoot(root);
    setDragOverRoot(null);
    setRootMenuOpenFor(null);
  }, []);

  const onWorkspaceRootDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>, root: string) => {
    if (!draggedRoot || draggedRoot === root) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const bounds = event.currentTarget.getBoundingClientRect();
    const placement = event.clientY >= bounds.top + bounds.height / 2 ? 'after' : 'before';
    setDragOverRoot((current) => (current?.root === root && current.placement === placement ? current : { root, placement }));
  }, [draggedRoot]);

  const onWorkspaceRootDrop = useCallback((event: ReactDragEvent<HTMLDivElement>, root: string) => {
    event.preventDefault();
    const sourceRoot = draggedRoot || event.dataTransfer.getData('text/plain');
    const placement = dragOverRoot?.root === root ? dragOverRoot.placement : 'before';
    setDraggedRoot(null);
    setDragOverRoot(null);
    if (!sourceRoot || sourceRoot === root) return;

    const nextRoots = reorderRoots(workspaceRoots, sourceRoot, root, placement);
    if (nextRoots === workspaceRoots) return;
    setWorkspaceRoots(nextRoots);
    void persistWorkspaceRoots(nextRoots);
  }, [dragOverRoot, draggedRoot, persistWorkspaceRoots, workspaceRoots]);

  const onWorkspaceRootDragEnd = useCallback(() => {
    setDraggedRoot(null);
    setDragOverRoot(null);
  }, []);

  useEffect(() => {
    void ensureFileVisible(activePath);
  }, [activePath, ensureFileVisible]);

  const loadDirChildren = useCallback(async (dirPath: string) => {
    if (loadingDirs.includes(dirPath)) return;
    setLoadingDirs((prev) => [...prev, dirPath]);
    try {
      const items = await fsClient.listWorkspaceDir(dirPath);
      items.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setTreeEntries((prev) => ({ ...prev, [dirPath]: items }));
    } finally {
      setLoadingDirs((prev) => prev.filter((item) => item !== dirPath));
    }
  }, [loadingDirs]);

  async function onPickWorkspace() {
    try {
      const root = await fsClient.selectWorkspaceFolder();
      if (!root) return;
      setWorkspaceRoots((prev) => prev.includes(root) ? prev : [...prev, root]);
      setWorkspaceRoot(root);
      setSuggestionText('');
      setSuggestionError('');
      setAgentPatches([]);
      setAgentStatus('');
      await refreshList(root);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to select workspace');
    }
  }

  const openWorkspaceFile = useCallback(async (filePath: string, options?: { reveal?: boolean }) => {
    const root = findWorkspaceRootForPath(filePath);
    if (!root) return false;

    if (root && root !== workspaceRoot) {
      await activateWorkspaceRoot(root);
    }

    const existing = openDocsRef.current.find((doc) => doc.path === filePath);
    if (existing) {
      setActivePath(filePath);
      setStatus('');
      if (options?.reveal) {
        if (isExplorerCollapsed) {
          setIsExplorerCollapsed(false);
        }
        await ensureFileVisible(filePath);
        requestAnimationFrame(() => {
          const selector = `[data-file-path="${CSS.escape(filePath)}"]`;
          const target = document.querySelector<HTMLElement>(selector);
          target?.scrollIntoView({ block: 'center' });
        });
      }
      return true;
    }

    try {
      const file = await fsClient.readWorkspaceFile(filePath);
      setOpenDocs((prev) => [...prev, {
        path: filePath,
        name: getFileName(filePath),
        text: file.kind === 'text' ? file.contents ?? '' : '',
        binaryContents: file.kind === 'binary' ? file.contents : null,
        contentsEncoding: file.contentsEncoding,
        mimeType: file.mimeType,
        fileState: { kind: file.kind, readOnly: file.readOnly, size: file.size },
        dirty: false,
        viewMode: isMarkdownFile(filePath) || isPdfFile(filePath) || isHtmlFile(filePath) ? 'preview' : 'edit'
      }]);
      setActivePath(filePath);
      setStatus('');
      setSuggestionText('');
      setSuggestionError('');
      setAgentPatches([]);
      setAgentStatus('');
      if (options?.reveal) {
        if (isExplorerCollapsed) {
          setIsExplorerCollapsed(false);
        }
        await ensureFileVisible(filePath);
      }
      return true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to open file');
      return false;
    }
  }, [activateWorkspaceRoot, ensureFileVisible, findWorkspaceRootForPath, isExplorerCollapsed, workspaceRoot]);

  const revealWorkspaceFile = useCallback(async (filePath: string) => {
    const root = findWorkspaceRootForPath(filePath);
    if (!root) return false;
    if (root !== workspaceRoot) {
      await activateWorkspaceRoot(root);
    }
    setCollapsedWorkspaceRoots((prev) => prev.filter((item) => item !== root));
    if (isExplorerCollapsed) {
      setIsExplorerCollapsed(false);
    }
    await ensureFileVisible(filePath);
    requestAnimationFrame(() => {
      const selector = `[data-file-path="${CSS.escape(filePath)}"]`;
      const target = document.querySelector<HTMLElement>(selector);
      target?.scrollIntoView({ block: 'center' });
    });
    return true;
  }, [activateWorkspaceRoot, ensureFileVisible, findWorkspaceRootForPath, isExplorerCollapsed, workspaceRoot]);

  async function onOpenEntry(entry: DirEntry) {
    if (entry.kind !== 'file') return;
    await openWorkspaceFile(entry.path);
  }

  async function onSave() {
    if (!canSave || !activeDoc) return;
    const ok = window.confirm(`Write changes to:\n\n${activeDoc.path}\n\nProceed?`);
    if (!ok) return;
    try {
      await fsClient.writeWorkspaceTextFile(activeDoc.path, activeDoc.text);
      setOpenDocs((prev) => prev.map((doc) => (doc.path === activeDoc.path ? { ...doc, dirty: false } : doc)));
      setStatus('Saved');
      setTimeout(() => setStatus(''), 1000);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to save file');
    }
  }

  async function onSaveAll() {
    const docsToSave = openDocs.filter((doc) => doc.dirty && doc.fileState.kind === 'text' && !doc.fileState.readOnly);
    if (!docsToSave.length) return;

    const ok = window.confirm(`Write changes to ${docsToSave.length} file(s)?`);
    if (!ok) return;

    try {
      for (const doc of docsToSave) {
        await fsClient.writeWorkspaceTextFile(doc.path, doc.text);
      }
      const savedPaths = new Set(docsToSave.map((doc) => doc.path));
      setOpenDocs((prev) => prev.map((doc) => (savedPaths.has(doc.path) ? { ...doc, dirty: false } : doc)));
      setStatus(`Saved ${docsToSave.length} file${docsToSave.length > 1 ? 's' : ''}`);
      setTimeout(() => setStatus(''), 1200);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to save all files');
    }
  }

  const togglePreviewMode = useCallback(() => {
    if (!canTogglePreview) return;
    updateActiveDoc((doc) => ({ ...doc, viewMode: doc.viewMode === 'preview' ? 'edit' : 'preview' }));
  }, [canTogglePreview]);

  const welcomeShortcutItems = useMemo<WelcomeShortcutItem[]>(() => {
    return [
      {
        id: 'open-project',
        title: 'Open Project',
        description: 'Add or switch a workspace folder in the Explorer.',
        keys: ['Mod', 'O'],
        run: () => void onPickWorkspace()
      },
      {
        id: 'toggle-explorer',
        title: isExplorerCollapsed ? 'Show Explorer' : 'Hide Explorer',
        description: 'Toggle the left file tree without leaving the editor area.',
        keys: ['Mod', 'B'],
        run: () => toggleExplorerPane()
      },
      {
        id: 'save-file',
        title: 'Save File',
        description: canSave ? 'Write the current editor changes to disk.' : 'Available when the active text file has unsaved changes.',
        keys: ['Mod', 'S'],
        disabled: !canSave,
        run: () => void onSave()
      },
      {
        id: 'save-all',
        title: 'Save All',
        description: dirtyDocCount ? `Write all ${dirtyDocCount} dirty file${dirtyDocCount > 1 ? 's' : ''} to disk.` : 'Available when more than one file has unsaved changes.',
        keys: ['Mod', 'Shift', 'S'],
        disabled: dirtyDocCount === 0,
        run: () => void onSaveAll()
      },
      {
        id: 'toggle-preview',
        title: 'Toggle Preview',
        description: canTogglePreview ? 'Switch between source and preview for Markdown or HTML.' : 'Available when a Markdown or HTML file is active.',
        keys: ['Mod', 'Shift', 'V'],
        disabled: !canTogglePreview,
        run: () => togglePreviewMode()
      }
    ];
  }, [canSave, canTogglePreview, dirtyDocCount, isExplorerCollapsed, togglePreviewMode]);

  useEffect(() => {
    function handleWorkspaceShortcut(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (!event.metaKey && !event.ctrlKey) return;

      const panel = panelRef.current;
      const activeElement = document.activeElement;
      if (!panel || !(activeElement instanceof HTMLElement) || !panel.contains(activeElement)) {
        return;
      }

      const key = event.key.toLowerCase();

      if (!event.shiftKey && !event.altKey && key === 'o') {
        event.preventDefault();
        void onPickWorkspace();
        return;
      }

      if (!event.shiftKey && !event.altKey && key === 'b') {
        event.preventDefault();
        toggleExplorerPane();
        return;
      }

      if (!event.altKey && key === 's') {
        event.preventDefault();
        if (event.shiftKey) {
          void onSaveAll();
        } else {
          void onSave();
        }
        return;
      }

      if (!event.altKey && event.shiftKey && key === 'v') {
        event.preventDefault();
        togglePreviewMode();
      }
    }

    window.addEventListener('keydown', handleWorkspaceShortcut);
    return () => {
      window.removeEventListener('keydown', handleWorkspaceShortcut);
    };
  }, [togglePreviewMode, canSave, dirtyDocCount, isExplorerCollapsed]);

  useEffect(() => {
    const off = fsClient.onWorkspaceEvent((event) => {
      if (event.type === 'error') {
        setStatus(event.message);
        return;
      }

      const root = findWorkspaceRootForPath(event.path) ?? workspaceRootRef.current;
      if (!root) return;
      scheduleWorkspaceRefresh(root, 'Workspace updated…');
    });

    return () => {
      off();
    };
  }, [findWorkspaceRootForPath, scheduleWorkspaceRefresh]);

  async function requestInlineCompletion() {
    if (!settings.inlineCompletionsEnabled) return;
    const el = editorRef.current;
    if (!el) return;

    inlineStreamRef.current?.close();
    setSuggestionText('');
    setSuggestionError('');
    setIsSuggesting(true);

    const cursorOffset = el.selectionStart ?? activeText.length;

    const stream = openInlineCompletionStream({
      providerId: settings.providerId as ProviderId,
      baseUrl: settings.providerId === 'openai_compat' ? settings.baseUrl : undefined,
      apiKey: settings.apiKey,
      model: settings.model,
      filePath: activePath ?? undefined,
      documentText: activeText,
      cursorOffset
    });
    inlineStreamRef.current = stream;

    const off = stream.onEvent((ev) => {
      if (ev.type === 'completion') {
        setSuggestionText(ev.text);
      } else if (ev.type === 'error') {
        setSuggestionError(ev.message);
        setIsSuggesting(false);
      } else if (ev.type === 'done') {
        off();
        stream.close();
        if (inlineStreamRef.current === stream) {
          inlineStreamRef.current = null;
        }
        setIsSuggesting(false);
      }
    });

    stream.onError((message) => {
      setSuggestionError(message);
      setIsSuggesting(false);
    });

    stream.onClose(() => {
      if (inlineStreamRef.current === stream) {
        inlineStreamRef.current = null;
      }
      setIsSuggesting(false);
    });
  }

  const requestAgentPatch = useCallback(async (taskOverride?: string) => {
    if (!settings.agentPatchesEnabled) return false;
    const task = typeof taskOverride === 'string' ? taskOverride.trim() : (window.prompt('Agent Patch task') ?? '').trim();
    if (!task) return false;

    agentStreamRef.current?.close();
    setAgentPatches([]);
    setAgentStatus('Starting…');

    const stream = openAgentPatchStream({
      providerId: settings.providerId as ProviderId,
      baseUrl: settings.providerId === 'openai_compat' ? settings.baseUrl : undefined,
      apiKey: settings.apiKey,
      model: settings.model,
      task,
      activeFilePath: activeDoc?.path,
      activeFileText: activeDoc?.text ?? ''
    });
    agentStreamRef.current = stream;

    const off = stream.onEvent((ev) => {
      if (ev.type === 'progress') {
        setAgentStatus(ev.message);
      } else if (ev.type === 'patch') {
        setAgentPatches(ev.patches);
        setAgentStatus('Patch ready');
      } else if (ev.type === 'error') {
        setAgentStatus(`Error: ${ev.message}`);
      } else if (ev.type === 'done') {
        off();
        stream.close();
        if (agentStreamRef.current === stream) {
          agentStreamRef.current = null;
        }
      }
    });

    stream.onError((message) => {
      setAgentStatus(`Error: ${message}`);
    });

    stream.onClose(() => {
      if (agentStreamRef.current === stream) {
        agentStreamRef.current = null;
      }
    });

    return true;
  }, [activeDoc, settings.agentPatchesEnabled, settings.apiKey, settings.baseUrl, settings.model, settings.providerId]);

  const applyAgentPatches = useCallback(async () => {
    if (!agentPatches.length) return false;
    const destructive = agentPatches.some((p) => p.operation === 'delete');
    if (destructive) {
      window.alert('Delete operations are not supported yet.');
      return false;
    }

    const ok = window.confirm(`Apply ${agentPatches.length} patch(es) to workspace?`);
    if (!ok) return false;

    try {
      for (const p of agentPatches) {
        if (p.operation === 'modify' || p.operation === 'create') {
          const nextText = p.newText ?? '';
          await fsClient.writeWorkspaceTextFile(p.filePath, nextText);
          setOpenDocs((prev) => prev.map((doc) => (
            doc.path === p.filePath
              ? {
                  ...doc,
                  text: nextText,
                  dirty: false,
                  fileState: { ...doc.fileState, kind: 'text', size: nextText.length }
                }
              : doc
          )));
        }
      }

      const touchedRoots = Array.from(new Set(agentPatches.map((patch) => findWorkspaceRootForPath(patch.filePath)).filter((root): root is string => Boolean(root))));
      await Promise.all(touchedRoots.map((root) => refreshList(root)));
      setAgentStatus('Applied');
      setStatus('Agent patches applied');
      return true;
    } catch (error) {
      setAgentStatus(error instanceof Error ? `Error: ${error.message}` : 'Error: failed to apply patches');
      return false;
    }
  }, [agentPatches, findWorkspaceRootForPath, refreshList]);

  useImperativeHandle(ref, () => ({
    requestAgentPatch,
    applyAgentPatches,
    openWorkspaceFile,
    revealWorkspaceFile,
    async syncExternalWrite(filePath: string, contents: string) {
      setOpenDocs((prev) => prev.map((doc) => (
        doc.path === filePath
          ? {
              ...doc,
              text: contents,
              binaryContents: null,
              contentsEncoding: 'utf8',
              mimeType: null,
              dirty: false,
              fileState: { ...doc.fileState, kind: 'text', size: contents.length }
            }
          : doc
      )));
      const root = findWorkspaceRootForPath(filePath);
      if (root) {
        await refreshList(root);
      }
    }
  }), [applyAgentPatches, findWorkspaceRootForPath, openWorkspaceFile, refreshList, requestAgentPatch, revealWorkspaceFile]);

  async function toggleDir(entry: DirEntry) {
    if (entry.kind !== 'dir') return;
    const isExpanded = expandedDirs.includes(entry.path);
    if (isExpanded) {
      setExpandedDirs((prev) => prev.filter((path) => path !== entry.path));
      return;
    }
    setExpandedDirs((prev) => [...prev, entry.path]);
    if (!treeEntries[entry.path]) {
      await loadDirChildren(entry.path);
    }
  }

  function toggleExplorerPane() {
    setIsExplorerCollapsed((prev) => !prev);
    setStatus(isExplorerCollapsed ? 'Explorer shown' : 'Explorer hidden');
    setTimeout(() => setStatus(''), 1000);
  }

  function updateActiveDoc(updater: (doc: OpenDoc) => OpenDoc) {
    if (!activePath) return;
    setOpenDocs((prev) => prev.map((doc) => (doc.path === activePath ? updater(doc) : doc)));
  }

  function closeDoc(path: string) {
    const doc = openDocs.find((item) => item.path === path);
    if (doc?.dirty) {
      const ok = window.confirm(`Close ${doc.name} without saving?`);
      if (!ok) return;
    }

    const nextDocs = openDocs.filter((docItem) => docItem.path !== path);
    setOpenDocs(nextDocs);
    if (activePath === path) {
      setActivePath(nextDocs.at(-1)?.path ?? null);
    }
  }

  function scrollPreviewToHeading(headingId: string) {
    const target = previewBodyRef.current?.querySelector<HTMLElement>(`#${CSS.escape(headingId)}`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function syncEditorOverlayScroll(target: HTMLTextAreaElement) {
    const overlay = editorOverlayRef.current;
    if (!overlay) return;
    overlay.scrollTop = target.scrollTop;
    overlay.scrollLeft = target.scrollLeft;
  }

  function getTreeItemPadding(depth: number) {
    if (depth <= 0) return 6;
    return 6 + 10 + ((depth - 1) * 16);
  }

  function getTreeChildrenStyle(depth: number) {
    if (depth <= 0) {
      return { marginLeft: '10px', paddingLeft: '6px' };
    }
    return {
      marginLeft: `${10 + depth * 4}px`,
      paddingLeft: `${6 + depth * 2}px`
    };
  }

  function renderEntry(entry: DirEntry, depth = 0) {
    const isExpanded = expandedDirs.includes(entry.path);
    const children = treeEntries[entry.path] ?? [];
    const isLoading = loadingDirs.includes(entry.path);
    const isOpen = openDocs.some((doc) => doc.path === entry.path);
    const icon = entry.kind === 'file' ? getExplorerFileIcon(entry.path) : null;

    return (
      <div key={entry.path} className="treeNode">
        <button
          className={[
            entry.path === activePath ? 'fileItem active' : isOpen ? 'fileItem open' : 'fileItem',
            flashFilePath === entry.path ? 'flash' : ''
          ].filter(Boolean).join(' ')}
          data-file-path={entry.path}
          onClick={() => {
            if (entry.kind === 'dir') {
              void toggleDir(entry);
            } else {
              void onOpenEntry(entry);
            }
          }}
          title={entry.path}
          style={{ paddingLeft: `${getTreeItemPadding(depth)}px` }}
        >
          <span className="treeToggle">{entry.kind === 'dir' ? (isExpanded ? '⌄' : '›') : ''}</span>
          <span className={entry.kind === 'dir' ? 'explorerIcon folder' : `explorerIcon file tone-${icon?.tone ?? 'slate'}`} aria-hidden="true">
            {entry.kind === 'dir' ? '' : icon?.label}
          </span>
          <span className="fileName">{entry.name}</span>
        </button>
        {entry.kind === 'dir' && isExpanded ? (
          <div className="treeNodeChildren" style={getTreeChildrenStyle(depth)}>
            {isLoading ? <div className="treeLoading" style={{ paddingLeft: `${getTreeItemPadding(depth + 1) + 18}px` }}>Loading…</div> : null}
            {children.map((child) => renderEntry(child, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  }

  function renderWorkspaceRootSection(root: string) {
    const entries = rootEntriesByRoot[root] ?? [];
    const isActiveRoot = root === workspaceRoot;
    const isCollapsed = collapsedWorkspaceRoots.includes(root);
    const rootName = getWorkspaceRootName(root);
    const isMenuOpen = rootMenuOpenFor === root;
    const isDropBefore = dragOverRoot?.root === root && dragOverRoot.placement === 'before';
    const isDropAfter = dragOverRoot?.root === root && dragOverRoot.placement === 'after';
    const sectionClassName = [
      'workspaceRootSection',
      isActiveRoot ? 'active' : '',
      draggedRoot === root ? 'dragging' : '',
      isDropBefore ? 'drop-before' : '',
      isDropAfter ? 'drop-after' : ''
    ].filter(Boolean).join(' ');

    return (
      <div
        key={root}
        className={sectionClassName}
        onDragOver={(event) => onWorkspaceRootDragOver(event, root)}
        onDrop={(event) => onWorkspaceRootDrop(event, root)}
      >
        <div className={isActiveRoot ? 'workspaceRootHeader active' : 'workspaceRootHeader'}>
          <button
            type="button"
            className="workspaceRootToggle"
            onClick={() => toggleWorkspaceRootSection(root)}
            aria-label={isCollapsed ? `Expand ${rootName}` : `Collapse ${rootName}`}
            title={isCollapsed ? 'Expand project' : 'Collapse project'}
          >
            <span className={isCollapsed ? 'workspaceRootChevron collapsed' : 'workspaceRootChevron'} aria-hidden="true">⌄</span>
          </button>
          <button
            type="button"
            className={isActiveRoot ? 'workspaceRootButton active' : 'workspaceRootButton'}
            draggable
            onClick={() => void activateWorkspaceRoot(root)}
            onDoubleClick={() => toggleWorkspaceRootSection(root)}
            onDragStart={(event) => onWorkspaceRootDragStart(event, root)}
            onDragEnd={onWorkspaceRootDragEnd}
            title={root}
            aria-label={`Project ${rootName}`}
          >
            <span className="workspaceRootName">{rootName}</span>
          </button>
          <div className="workspaceRootMenuAnchor">
            <button
              type="button"
              className={isMenuOpen ? 'workspaceRootAction active' : 'workspaceRootAction'}
              onClick={() => setRootMenuOpenFor((current) => current === root ? null : root)}
              aria-label={`Project actions for ${rootName}`}
              aria-expanded={isMenuOpen}
              title={`Project actions for ${rootName}`}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 6h.01M12 12h.01M12 18h.01" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
              </svg>
            </button>
            {isMenuOpen ? (
              <div className="workspaceRootMenu" role="menu">
                <button type="button" className="workspaceRootMenuItem" onClick={() => void activateWorkspaceRoot(root)} role="menuitem" disabled={isActiveRoot}>
                  Activate Project
                </button>
                <button type="button" className="workspaceRootMenuItem" onClick={() => toggleWorkspaceRootSection(root)} role="menuitem">
                  {isCollapsed ? 'Expand Project' : 'Collapse Project'}
                </button>
                <button type="button" className="workspaceRootMenuItem danger" onClick={() => void removeWorkspaceRoot(root)} role="menuitem">
                  Remove From Workspace
                </button>
              </div>
            ) : null}
          </div>
        </div>
        {!isCollapsed ? (
          <div className="workspaceRootEntries">
            {entries.length ? entries.map((entry) => renderEntry(entry)) : <div className="empty">No files found.</div>}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="workspaceCard" ref={panelRef}>
      <div className="workspaceHeader">
        <div className="workspaceHeaderPrimary">
          <button onClick={onPickWorkspace}>Open Project…</button>
          <div className="workspaceHeaderMeta">
            <div className="cardTitle">Project</div>
            <div className="workspacePath" title={workspaceRoot ?? 'No project selected'}>
              {workspaceRoot
                ? `${activeWorkspaceRootName} · ${workspaceRoots.length} project${workspaceRoots.length > 1 ? 's' : ''} open · ${workspaceRoot}`
                : 'No project selected'}
            </div>
          </div>
        </div>
      </div>

      <div className={isExplorerCollapsed ? 'workspaceBody explorerCollapsed' : 'workspaceBody'} style={!isExplorerCollapsed ? { gridTemplateColumns: `${explorerWidth}px 8px minmax(0, 1fr)` } : undefined}>
        {!isExplorerCollapsed ? (
        <div className="fileList">
          <div className="explorerHeader">
            <span>Explorer</span>
            <div className="explorerHeaderActions">
              <button
                type="button"
                className="explorerHeaderLocate"
                onClick={() => void revealCurrentFile()}
                aria-label="Locate current file in Explorer"
                title={activePath ? 'Select Opened File in Explorer' : 'Open a file to select it in Explorer'}
                disabled={!activePath}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="7.25" fill="none" stroke="currentColor" strokeWidth="1.7" />
                  <circle cx="12" cy="12" r="2.25" fill="currentColor" />
                </svg>
              </button>
              <button
                type="button"
                className="explorerHeaderToggle"
                onClick={toggleExplorerPane}
                title="Hide Explorer"
                aria-label="Hide Explorer"
              >
                ‹
              </button>
            </div>
          </div>
          <div className="explorerTree">
          {workspaceRoots.length ? (
            workspaceRoots.map((root) => renderWorkspaceRootSection(root))
          ) : (
            <div className="empty">Open a project to browse files.</div>
          )}
          </div>
        </div>
        ) : null}

        <div
          className={isExplorerCollapsed ? 'workspaceSplitHandle collapsed' : 'workspaceSplitHandle'}
          onPointerDown={(ev) => {
            if (isExplorerCollapsed) return;
            splitDragRef.current = { startX: ev.clientX, startWidth: explorerWidth };
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';
          }}
        >
          {isExplorerCollapsed ? (
            <button type="button" className="explorerPaneToggle" onClick={toggleExplorerPane} aria-label="Show Explorer">
              ›
            </button>
          ) : null}
        </div>

        <div className="editorPane">
          {openDocs.length ? (
            <>
              <div className="editorTabs">
                {openDocs.map((doc) => (
                  <div key={doc.path} className={doc.path === activePath ? 'editorTab active' : 'editorTab'}>
                    <button type="button" className="editorTabMain" onClick={() => setActivePath(doc.path)}>
                      <span>{doc.name}</span>
                      {doc.dirty ? <span className="editorTabDirty">•</span> : null}
                    </button>
                    <button type="button" className="editorTabClose" onClick={() => closeDoc(doc.path)} aria-label={`Close ${doc.name}`}>
                      x
                    </button>
                  </div>
                ))}
              </div>

              {activeDoc ? (
                <>
                  <div className="editorHeader">
                    <button type="button" className="editorPath" title={activeDoc.path} onClick={() => void revealCurrentFile()}>
                      {activeDoc.path}
                    </button>
                    <div className="editorActions">
                      <button type="button" onClick={() => void revealCurrentFile()}>
                        Reveal in Explorer
                      </button>
                      <div className="fileBadge strong">{activeFileType}</div>
                      {activeDoc.fileState.kind === 'binary' ? <div className="fileBadge strong">BIN</div> : null}
                      {activeDoc.fileState.readOnly ? <div className="fileBadge strong">RO</div> : null}
                      <button
                        type="button"
                        className={dirtyDocCount ? 'editorActionButton' : 'editorActionButton hidden'}
                        onClick={() => void onSaveAll()}
                        disabled={!dirtyDocCount}
                        title={dirtyDocCount ? `Save all dirty files (${dirtyDocCount})` : 'No dirty files to save'}
                      >
                        Save All
                      </button>
                      <button
                        type="button"
                        className={canTogglePreview ? 'editorActionButton' : 'editorActionButton hidden'}
                        onClick={togglePreviewMode}
                        disabled={!canTogglePreview}
                      >
                        {activeDoc.viewMode === 'preview' ? 'Edit' : 'Preview'}
                      </button>
                      <div className="statusText">{status || '\u00A0'}</div>
                      <button onClick={onSave} disabled={!canSave}>
                        Save
                      </button>
                    </div>
                  </div>

                  {activeDoc.fileState.kind === 'binary' ? (
                    isPdfFile(activeDoc.path) && activePdfUrl ? (
                      <div className="editorPreview pdfPreviewShell">
                        <iframe className="pdfPreviewFrame" src={activePdfUrl} title={activeDoc.name} />
                      </div>
                    ) : (
                      <div className="footerHint">Binary file detected. Preview/edit is disabled in this panel.</div>
                    )
                  ) : activeDoc.viewMode === 'preview' && isHtmlFile(activeDoc.path) ? (
                    activeHtmlPreview.srcDoc ? (
                      <div className="editorPreview htmlPreviewShell">
                        <iframe
                          className="htmlPreviewFrame"
                          srcDoc={activeHtmlPreview.srcDoc ?? undefined}
                          title={activeDoc.name}
                          sandbox="allow-same-origin allow-scripts allow-forms allow-modals"
                        />
                      </div>
                    ) : (
                      <div className="footerHint">HTML preview is unavailable until a workspace root is selected.</div>
                    )
                  ) : activeDoc.viewMode === 'preview' && isMarkdownFile(activeDoc.path) ? (
                    <div className="editorPreview editorPreviewLayout">
                      {markdownPreview.headings.length ? (
                        <aside className="markdownToc">
                          <div className="markdownTocTitle">On This Page</div>
                          <div className="markdownTocList">
                            {markdownPreview.headings.map((heading) => (
                              <button
                                key={heading.id}
                                type="button"
                                className={`markdownTocItem level-${Math.min(heading.level, 4)}`}
                                onClick={() => scrollPreviewToHeading(heading.id)}
                              >
                                {heading.text}
                              </button>
                            ))}
                          </div>
                        </aside>
                      ) : null}
                      <div ref={previewBodyRef} className="markdownPreviewBody">
                        <div className="markdownPreview">
                          <MarkdownPreviewContent markdown={activeDoc.text} />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className={isJavaFile(activeDoc.path) ? 'editorSurface syntaxHighlighted' : 'editorSurface'}>
                      {isJavaFile(activeDoc.path) ? (
                        <pre ref={editorOverlayRef} className="editorSyntax" aria-hidden="true">
                          <code dangerouslySetInnerHTML={{ __html: javaEditorHighlight }} />
                        </pre>
                      ) : null}
                      <textarea
                        ref={editorRef}
                        className={isJavaFile(activeDoc.path) ? 'editor editorWithSyntax' : 'editor'}
                        value={activeDoc.text}
                        onChange={(e) => {
                          if (activeDoc.fileState.readOnly) return;
                          updateActiveDoc((doc) => ({
                            ...doc,
                            text: e.target.value,
                            dirty: true,
                            fileState: { ...doc.fileState, size: e.target.value.length }
                          }));
                          setSuggestionText('');
                          setSuggestionError('');
                        }}
                        onScroll={(e) => syncEditorOverlayScroll(e.currentTarget)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            if (suggestionText) {
                              e.preventDefault();
                              setSuggestionText('');
                              setSuggestionError('');
                            }
                            return;
                          }

                          if (e.key === 'Tab' && suggestionText) {
                            e.preventDefault();
                            const el = e.currentTarget;
                            const start = el.selectionStart ?? activeDoc.text.length;
                            const end = el.selectionEnd ?? start;
                            const accepted = suggestionText;
                            const next = activeDoc.text.slice(0, start) + accepted + activeDoc.text.slice(end);
                            updateActiveDoc((doc) => ({
                              ...doc,
                              text: next,
                              dirty: true,
                              fileState: { ...doc.fileState, size: next.length }
                            }));
                            setSuggestionText('');
                            setSuggestionError('');
                            queueMicrotask(() => {
                              try {
                                el.selectionStart = el.selectionEnd = start + accepted.length;
                              } catch {
                                // ignore
                              }
                              syncEditorOverlayScroll(el);
                            });
                            return;
                          }

                          if (e.ctrlKey && e.key === ' ') {
                            e.preventDefault();
                            void requestInlineCompletion();
                          }
                        }}
                        spellCheck={false}
                        readOnly={activeDoc.fileState.readOnly}
                      />
                    </div>
                  )}

                  {activeDoc.fileState.readOnly ? (
                    <div className="footerHint">This file is read-only on disk. You can inspect it here, but saving is disabled.</div>
                  ) : null}

                  {settings.inlineCompletionsEnabled && activeDoc.fileState.kind === 'text' && activeDoc.viewMode === 'edit' ? (
                    <div style={{ marginTop: 8 }}>
                      {isSuggesting ? <div className="footerHint">Suggesting…</div> : null}
                      {suggestionError ? <div className="footerHint">Inline error: {suggestionError}</div> : null}
                      {suggestionText ? <div className="footerHint">Suggestion: {suggestionText} (Tab to accept, Esc to dismiss)</div> : null}
                    </div>
                  ) : null}

                  {settings.agentPatchesEnabled ? (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <button type="button" onClick={() => void requestAgentPatch()}>
                          Agent Patch…
                        </button>
                        <div className="footerHint">{agentStatus}</div>
                      </div>

                      {agentPatches.length ? (
                        <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
                          <div className="footerHint">Patches:</div>
                          {agentPatches.map((p, idx) => (
                            <div key={idx} style={{ display: 'grid', gap: 6 }}>
                              <div className="pill" style={{ opacity: 1 }}>
                                {p.operation.toUpperCase()} {p.filePath}
                              </div>
                              {'newText' in p && typeof p.newText === 'string' ? (
                                <textarea readOnly rows={6} value={p.newText} style={{ width: '100%' }} />
                              ) : (
                                <div className="footerHint">(no preview)</div>
                              )}
                            </div>
                          ))}
                          <button type="button" onClick={() => void applyAgentPatches()}>
                            Apply patches
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : null}
            </>
          ) : (
            <div className="workspaceWelcome">
              <div className="workspaceWelcomeContent">
                <div className="workspaceWelcomeHero">
                  <div className="workspaceWelcomeEyebrow">Workspace</div>
                  <h2 className="workspaceWelcomeTitle">{workspaceRoot ? 'Open a file to start editing' : 'Open a project to get started'}</h2>
                  <p className="workspaceWelcomeLead">
                    {workspaceRoot
                      ? 'Use the Explorer on the left, or jump into a common project file from the shortcuts below.'
                      : 'Pick a folder to load the Explorer, preview HTML and Markdown files, and edit multiple files side by side.'}
                  </p>
                </div>

                <div className="workspaceWelcomeActions">
                  <button type="button" className="workspaceWelcomeAction primary" onClick={() => void onPickWorkspace()}>
                    Open Project…
                  </button>
                  <button type="button" className="workspaceWelcomeAction" onClick={toggleExplorerPane}>
                    {isExplorerCollapsed ? 'Show Explorer' : 'Hide Explorer'}
                  </button>
                </div>

                {welcomeQuickOpenEntries.length ? (
                  <div className="workspaceWelcomeSection">
                    <div className="workspaceWelcomeSectionTitle">Quick Open</div>
                    <div className="workspaceWelcomeFileList">
                      {welcomeQuickOpenEntries.map((entry) => (
                        <button
                          key={entry.path}
                          type="button"
                          className="workspaceWelcomeFile"
                          onClick={() => void openWorkspaceFile(entry.path)}
                          title={entry.path}
                        >
                          <span className={`explorerIcon file tone-${getExplorerFileIcon(entry.path).tone}`} aria-hidden="true">
                            {getExplorerFileIcon(entry.path).label}
                          </span>
                          <span className="workspaceWelcomeFileText">
                            <span className="workspaceWelcomeFileName">{entry.name}</span>
                            <span className="workspaceWelcomeFilePath">{toWorkspaceRelativePath(workspaceRoot ?? '', entry.path)}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="workspaceWelcomeSection">
                  <div className="workspaceWelcomeSectionTitle">Common Shortcuts</div>
                  <div className="workspaceShortcutList">
                    {welcomeShortcutItems.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={item.disabled ? 'workspaceShortcutCard disabled' : 'workspaceShortcutCard'}
                        onClick={() => {
                          if (item.disabled) return;
                          void item.run();
                        }}
                        disabled={item.disabled}
                      >
                        <span className="workspaceShortcutMeta">
                          <span className="workspaceShortcutTitle">{item.title}</span>
                          <span className="workspaceShortcutDescription">{item.description}</span>
                        </span>
                        <span className="workspaceShortcutKey">{formatShortcutLabel(item.keys, isMacLike)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
