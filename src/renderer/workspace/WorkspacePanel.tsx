import GithubSlugger from 'github-slugger';
import { Suspense, lazy, type DragEvent as ReactDragEvent, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
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

const STARTER_PROJECT_ROOT_NAME = 'starter-project';
const STARTER_PROJECT_GUIDE_NAME = '新手引导.md';

type ExplorerActionTarget = DirEntry | { name: string; path: string; kind: 'root' };
type EditorTabContextMenuState = { x: number; y: number; path: string };
type ExplorerInputState = {
  mode: 'create-file' | 'create-dir' | 'copy';
  targetDir: string;
  sourceEntry: DirEntry | null;
  title: string;
  confirmLabel: string;
  value: string;
};

const MarkdownPreviewContent = lazy(() => import('./MarkdownPreviewContent'));

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

function getParentPath(targetPath: string) {
  const normalized = targetPath.replace(/[\\/]+$/, '');
  const separatorIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return separatorIndex > 0 ? normalized.slice(0, separatorIndex) : normalized;
}

function joinWorkspacePath(basePath: string, nextSegment: string) {
  return `${basePath.replace(/[\\/]$/, '')}/${nextSegment.replace(/^[/\\]+/, '')}`;
}

function buildCopyName(name: string, kind: DirEntry['kind']) {
  if (kind === 'dir') return `${name} copy`;
  const match = /^(.*?)(\.[^.]*)?$/.exec(name);
  const stem = match?.[1] || name;
  const extension = match?.[2] || '';
  return `${stem} copy${extension}`;
}

function getWorkspaceRootName(rootPath: string) {
  return rootPath.split(/[\\/]/).filter(Boolean).pop() ?? rootPath;
}

function isPathInsideRoot(rootPath: string, filePath: string) {
  return filePath === rootPath || filePath.startsWith(`${rootPath}/`) || filePath.startsWith(`${rootPath}\\`);
}

function isPathRelated(leftPath: string | null | undefined, rightPath: string | null | undefined) {
  if (!leftPath || !rightPath) return false;
  return leftPath === rightPath
    || leftPath.startsWith(`${rightPath}/`)
    || leftPath.startsWith(`${rightPath}\\`)
    || rightPath.startsWith(`${leftPath}/`)
    || rightPath.startsWith(`${leftPath}\\`);
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
  const lines = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }

    if (inFence) continue;

    const atxMatch = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(trimmed);
    if (atxMatch) {
      const text = atxMatch[2]?.trim() ?? '';
      if (!text) continue;
      headings.push({
        id: slugger.slug(text),
        text,
        level: atxMatch[1].length
      });
      continue;
    }

    const nextLine = lines[index + 1]?.trim() ?? '';
    if (!trimmed || !nextLine) continue;

    if (/^==+$/.test(nextLine) || /^--+$/.test(nextLine)) {
      headings.push({
        id: slugger.slug(trimmed),
        text: trimmed,
        level: /^==+$/.test(nextLine) ? 1 : 2
      });
      index += 1;
    }
  }

  return headings;
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
  workspaceScopePath: string | null;
  activePath: string | null;
  selectedPath: string | null;
  selectedEntryKind: 'file' | 'dir' | null;
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
  onOpenGitPage?: () => void;
  onRunCommandInTerminal?: (command: string, timeoutMs?: number) => Promise<unknown>;
}>(function WorkspacePanel(props, ref) {
  const { onContextChange, onOpenGitPage, settings } = props;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const editorOverlayRef = useRef<HTMLPreElement | null>(null);
  const previewBodyRef = useRef<HTMLDivElement | null>(null);
  const editorTabsRef = useRef<HTMLDivElement | null>(null);
  const inlineStreamRef = useRef<{ close: () => void } | null>(null);
  const agentStreamRef = useRef<{ close: () => void } | null>(null);
  const splitDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const workspaceRootRef = useRef<string | null>(null);
  const activePathRef = useRef<string | null>(null);
  const expandedDirsRef = useRef<string[]>([]);
  const openDocsRef = useRef<OpenDoc[]>([]);
  const autoOpenedStarterGuideRootsRef = useRef<Set<string>>(new Set());
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
  const [selectedExplorerEntry, setSelectedExplorerEntry] = useState<DirEntry | null>(null);
  const [copiedExplorerEntry, setCopiedExplorerEntry] = useState<DirEntry | null>(null);
  const [explorerToast, setExplorerToast] = useState<string>('');
  const [explorerInputState, setExplorerInputState] = useState<ExplorerInputState | null>(null);
  const [explorerContextMenu, setExplorerContextMenu] = useState<null | { x: number; y: number; target: ExplorerActionTarget; mode: 'create' | 'full' }>(null);
  const [editorTabContextMenu, setEditorTabContextMenu] = useState<EditorTabContextMenuState | null>(null);
  const [activeWorkspaceBranch, setActiveWorkspaceBranch] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const [isRefreshingWorkspace, setIsRefreshingWorkspace] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [rootMenuOpenFor, setRootMenuOpenFor] = useState<string | null>(null);
  const [entryMenuOpenFor, setEntryMenuOpenFor] = useState<string | null>(null);
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
  const explorerToastTimerRef = useRef<number | null>(null);
  const explorerInputRef = useRef<HTMLInputElement | null>(null);
  const isMacLike = useMemo(() => /Mac|iPhone|iPad|iPod/i.test(navigator.platform), []);

  const rootEntries = useMemo(() => (workspaceRoot ? rootEntriesByRoot[workspaceRoot] ?? [] : []), [rootEntriesByRoot, workspaceRoot]);
  const activeDoc = useMemo(() => openDocs.find((doc) => doc.path === activePath) ?? null, [activePath, openDocs]);
  const activeText = activeDoc?.text ?? '';
  const dirty = activeDoc?.dirty ?? false;
  const activeJavaInfo = useMemo(() => analyzeJavaDocument(activeDoc), [activeDoc]);
  const javaProjectInfo = useMemo(() => detectJavaProject(rootEntries, activeDoc, activeJavaInfo), [activeDoc, activeJavaInfo, rootEntries]);
  const [javaEditorHighlight, setJavaEditorHighlight] = useState('');
  const shouldHighlightJavaEditor = !!activeDoc && activeDoc.fileState.kind === 'text' && activeDoc.viewMode === 'edit' && isJavaFile(activeDoc.path);

  useEffect(() => {
    if (!shouldHighlightJavaEditor || !activeDoc) {
      setJavaEditorHighlight('');
      return;
    }

    let cancelled = false;
    const source = activeDoc.text.length ? activeDoc.text : ' ';
    const fallback = activeDoc.text.endsWith('\n') ? `${escapeHtml(source)}\n ` : escapeHtml(source);
    setJavaEditorHighlight(fallback);

    void import('highlight.js').then((module) => {
      if (cancelled) return;
      try {
        const highlighted = module.default.highlight(source, { language: 'java' }).value;
        setJavaEditorHighlight(activeDoc.text.endsWith('\n') ? `${highlighted}\n ` : highlighted);
      } catch {
        setJavaEditorHighlight(fallback);
      }
    }).catch(() => {
      if (cancelled) return;
      setJavaEditorHighlight(fallback);
    });

    return () => {
      cancelled = true;
    };
  }, [activeDoc, shouldHighlightJavaEditor]);

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
    activePathRef.current = activePath;
  }, [activePath]);

  useEffect(() => {
    if (!workspaceRoot) {
      setActiveWorkspaceBranch(null);
      return;
    }

    let cancelled = false;

    void fsClient.getGitRepository(workspaceRoot)
      .then((repository) => {
        if (cancelled) return;
        setActiveWorkspaceBranch(repository.gitRoot ? repository.branch : null);
      })
      .catch(() => {
        if (cancelled) return;
        setActiveWorkspaceBranch(null);
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceRoot]);

  useEffect(() => {
    onContextChange?.({
      workspaceRoot,
      workspaceScopePath: selectedExplorerEntry?.kind === 'dir' ? selectedExplorerEntry.path : workspaceRoot,
      activePath,
      selectedPath: selectedExplorerEntry?.path ?? activePath,
      selectedEntryKind: selectedExplorerEntry?.kind ?? (activePath ? 'file' : null),
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
  }, [activeJavaInfo, activePath, activeText, agentPatches.length, agentStatus, dirty, javaProjectInfo, onContextChange, rootEntries, selectedExplorerEntry, workspaceRoot]);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
      if (explorerToastTimerRef.current !== null) {
        window.clearTimeout(explorerToastTimerRef.current);
        explorerToastTimerRef.current = null;
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
      if (
        !(target instanceof HTMLElement)
        || target.closest('.workspaceRootMenuAnchor')
        || target.closest('.explorerEntryMenuAnchor')
        || target.closest('.explorerContextMenu')
        || target.closest('.editorTabContextMenu')
        || target.closest('.explorerInputDialog')
      ) {
        return;
      }
      setRootMenuOpenFor(null);
      setEntryMenuOpenFor(null);
      setExplorerContextMenu(null);
      setEditorTabContextMenu(null);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setRootMenuOpenFor(null);
        setEntryMenuOpenFor(null);
        setExplorerContextMenu(null);
        setEditorTabContextMenu(null);
        setExplorerInputState(null);
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
    if (!explorerInputState) return;
    requestAnimationFrame(() => {
      explorerInputRef.current?.focus();
      explorerInputRef.current?.select();
    });
  }, [explorerInputState]);

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

  const refreshExplorerIncremental = useCallback(async (root: string, changedPath?: string | null) => {
    const normalizedChangedPath = changedPath && isPathInsideRoot(root, changedPath) ? changedPath : null;
    const relativePath = normalizedChangedPath
      ? normalizedChangedPath.slice(root.length).replace(/^[/\\]/, '')
      : '';
    const shouldRefreshRootEntries = !normalizedChangedPath || !relativePath || !relativePath.includes('/') && !relativePath.includes('\\');

    if (shouldRefreshRootEntries) {
      const nextRootEntries = sortEntries(await fsClient.listWorkspaceDir(root));
      setRootEntriesByRoot((prev) => ({ ...prev, [root]: nextRootEntries }));
    }

    const expanded = expandedDirsRef.current.filter((dirPath) => !normalizedChangedPath || isPathRelated(dirPath, normalizedChangedPath));
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

  const revealWorkspaceRoot = useCallback(async (root: string) => {
    setCollapsedWorkspaceRoots((prev) => prev.filter((item) => item !== root));
    if (isExplorerCollapsed) {
      setIsExplorerCollapsed(false);
    }
    requestAnimationFrame(() => {
      const selector = `[data-workspace-root="${CSS.escape(root)}"]`;
      const target = document.querySelector<HTMLElement>(selector);
      target?.scrollIntoView({ block: 'center' });
    });
  }, [isExplorerCollapsed]);

  const refreshOpenDocsFromDisk = useCallback(async (changedPath?: string | null) => {
    const docs = openDocsRef.current;
    const cleanDocs = docs.filter((doc) => !doc.dirty && (!changedPath || isPathRelated(doc.path, changedPath)));
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

  const scheduleWorkspaceRefresh = useCallback((root: string, changedPath?: string | null, reason?: string) => {
    if (reason) {
      setStatus(reason);
    }
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      if (!root) return;
      void refreshExplorerIncremental(root, changedPath)
        .then(() => refreshOpenDocsFromDisk(changedPath))
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
    setSelectedExplorerEntry(null);
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
      setSelectedExplorerEntry((prev) => prev && isPathInsideRoot(root, prev.path) ? null : prev);
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

  const closeExplorerMenus = useCallback(() => {
    setRootMenuOpenFor(null);
    setEntryMenuOpenFor(null);
    setExplorerContextMenu(null);
  }, []);

  const showExplorerToast = useCallback((message: string) => {
    setExplorerToast(message);
    if (explorerToastTimerRef.current !== null) {
      window.clearTimeout(explorerToastTimerRef.current);
    }
    explorerToastTimerRef.current = window.setTimeout(() => {
      setExplorerToast('');
      explorerToastTimerRef.current = null;
    }, 1800);
  }, []);

  const getExplorerPasteTarget = useCallback(() => {
    if (selectedExplorerEntry?.kind === 'dir') return selectedExplorerEntry.path;
    if (selectedExplorerEntry?.kind === 'file') return getParentPath(selectedExplorerEntry.path);
    return workspaceRoot;
  }, [selectedExplorerEntry, workspaceRoot]);

  const beginCreateEntry = useCallback((dirPath: string, kind: 'file' | 'dir') => {
    setExplorerContextMenu(null);
    setExplorerInputState({
      mode: kind === 'file' ? 'create-file' : 'create-dir',
      targetDir: dirPath,
      sourceEntry: null,
      title: kind === 'file' ? 'Create file' : 'Create folder',
      confirmLabel: kind === 'file' ? 'Create File' : 'Create Folder',
      value: kind === 'file' ? 'untitled.txt' : 'new-folder'
    });
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
    } catch {
      setTreeEntries((prev) => {
        if (!(dirPath in prev)) return prev;
        const next = { ...prev };
        delete next[dirPath];
        return next;
      });
      setExpandedDirs((prev) => prev.filter((item) => item !== dirPath));
    } finally {
      setLoadingDirs((prev) => prev.filter((item) => item !== dirPath));
    }
  }, [loadingDirs]);

  const refreshWorkspaceRoot = useCallback(async (root: string) => {
    await refreshList(root);
    const expandedDirsInRoot = expandedDirsRef.current.filter((dirPath) => isPathInsideRoot(root, dirPath));
    await Promise.all(expandedDirsInRoot.map((dirPath) => loadDirChildren(dirPath)));
  }, [loadDirChildren, refreshList]);

  const refreshAllWorkspaces = useCallback(async () => {
    if (!workspaceRoots.length) return;
    setIsRefreshingWorkspace(true);
    try {
      await Promise.all(workspaceRoots.map((root) => refreshWorkspaceRoot(root)));
      setStatus(`Refreshed ${workspaceRoots.length} project${workspaceRoots.length > 1 ? 's' : ''}`);
      setLastRefreshedAt(Date.now());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to refresh workspace');
    } finally {
      setIsRefreshingWorkspace(false);
    }
  }, [refreshWorkspaceRoot, workspaceRoots]);

  async function onPickWorkspace() {
    try {
      const root = await fsClient.selectWorkspaceFolder();
      if (!root) return;
      if (workspaceRoots.includes(root)) {
        await activateWorkspaceRoot(root);
        await revealWorkspaceRoot(root);
        setStatus('');
        showExplorerToast(`${getWorkspaceRootName(root)} is already open`);
        return;
      }
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

  useEffect(() => {
    if (!workspaceRoot) return;
    if (getFileName(workspaceRoot) !== STARTER_PROJECT_ROOT_NAME) return;
    if (autoOpenedStarterGuideRootsRef.current.has(workspaceRoot)) return;
    if (openDocsRef.current.length > 0 || activePathRef.current) return;

    const guideEntry = rootEntries.find((entry) => entry.kind === 'file' && entry.name === STARTER_PROJECT_GUIDE_NAME);
    if (!guideEntry) return;

    autoOpenedStarterGuideRootsRef.current.add(workspaceRoot);
    void openWorkspaceFile(guideEntry.path);
  }, [openWorkspaceFile, rootEntries, workspaceRoot]);

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
    setSelectedExplorerEntry(entry);
    await openWorkspaceFile(entry.path);
  }

  function removeDocsForPath(targetPath: string) {
    const currentDocs = openDocsRef.current;
    const nextDocs = currentDocs.filter((doc) => !isPathRelated(doc.path, targetPath));
    setOpenDocs(nextDocs);
    setActivePath((prev) => (prev && isPathRelated(prev, targetPath) ? nextDocs.at(-1)?.path ?? null : prev));
    setSelectedExplorerEntry((prev) => (prev && isPathRelated(prev.path, targetPath) ? null : prev));
  }

  async function createEntryInDirectory(dirPath: string, kind: 'file' | 'dir') {
    beginCreateEntry(dirPath, kind);
  }

  async function submitExplorerInput() {
    const request = explorerInputState;
    if (!request) return;
    const requestedName = request?.value.trim();
    if (!requestedName) return;
    const nextPath = joinWorkspacePath(request.targetDir, requestedName);
    const root = findWorkspaceRootForPath(nextPath);
    if (!root) return;

    try {
      if (request.mode === 'create-file') {
        await fsClient.createWorkspaceFile(nextPath, '');
      } else if (request.mode === 'create-dir') {
        await fsClient.createWorkspaceDir(nextPath);
      } else {
        if (!request.sourceEntry) return;
        await fsClient.copyWorkspaceEntry(request.sourceEntry.path, nextPath);
      }
      await refreshExplorerIncremental(root, nextPath);
      await ensureFileVisible(nextPath);
      setCollapsedWorkspaceRoots((prev) => prev.filter((item) => item !== root));
      setExplorerInputState(null);
      setStatus(
        request.mode === 'create-file'
          ? 'File created'
          : request.mode === 'create-dir'
            ? 'Folder created'
            : request.sourceEntry?.kind === 'dir'
              ? 'Folder copied'
              : 'File copied'
      );
      closeExplorerMenus();

      if (request.mode === 'create-file' || (request.mode === 'copy' && request.sourceEntry?.kind === 'file')) {
        await openWorkspaceFile(nextPath, { reveal: true });
      } else {
        setSelectedExplorerEntry({ name: requestedName, path: nextPath, kind: 'dir' });
        setExpandedDirs((prev) => Array.from(new Set([...prev, request.targetDir, nextPath])));
        await loadDirChildren(request.targetDir);
        await loadDirChildren(nextPath);
      }
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : request.mode === 'copy'
            ? 'Failed to copy item'
            : request.mode === 'create-dir'
              ? 'Failed to create folder'
              : 'Failed to create file'
      );
    }
  }

  async function copyEntry(entry: DirEntry) {
    setCopiedExplorerEntry(entry);
    showExplorerToast(`${entry.kind === 'dir' ? 'Folder' : 'File'} copied to clipboard`);
  }

  async function pasteEntry(targetDirOverride?: string | null) {
    if (!copiedExplorerEntry) return;
    const targetDir = targetDirOverride ?? getExplorerPasteTarget();
    if (!targetDir) return;

    if (copiedExplorerEntry.kind === 'dir' && isPathInsideRoot(copiedExplorerEntry.path, targetDir)) {
      setStatus('Cannot paste a folder into itself');
      showExplorerToast('Cannot paste a folder into itself');
      return;
    }

    const destinationPath = joinWorkspacePath(targetDir, buildCopyName(copiedExplorerEntry.name, copiedExplorerEntry.kind));
    const root = findWorkspaceRootForPath(destinationPath);
    if (!root) return;

    try {
      await fsClient.copyWorkspaceEntry(copiedExplorerEntry.path, destinationPath);
      await refreshExplorerIncremental(root, destinationPath);
      await ensureFileVisible(destinationPath);
      setCollapsedWorkspaceRoots((prev) => prev.filter((item) => item !== root));
      setStatus(copiedExplorerEntry.kind === 'dir' ? 'Folder pasted' : 'File pasted');

      if (copiedExplorerEntry.kind === 'file') {
        await openWorkspaceFile(destinationPath, { reveal: true });
      } else {
        setSelectedExplorerEntry({
          name: getFileName(destinationPath),
          path: destinationPath,
          kind: 'dir'
        });
        setExpandedDirs((prev) => Array.from(new Set([...prev, targetDir, destinationPath])));
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `Failed to paste ${copiedExplorerEntry.kind}`);
    }
  }

  async function deleteEntry(entry: DirEntry) {
    const relatedDocs = openDocsRef.current.filter((doc) => isPathRelated(doc.path, entry.path));
    const hasDirtyDocs = relatedDocs.some((doc) => doc.dirty);
    const prompt = hasDirtyDocs
      ? `Delete ${entry.name}? Unsaved editor changes will be lost.`
      : `Delete ${entry.name}?`;
    if (!window.confirm(prompt)) return;

    const root = findWorkspaceRootForPath(entry.path);
    if (!root) return;

    try {
      await fsClient.deleteWorkspaceEntry(entry.path);
      removeDocsForPath(entry.path);
      await refreshExplorerIncremental(root, getParentPath(entry.path));
      setStatus(entry.kind === 'dir' ? 'Folder deleted' : 'File deleted');
      closeExplorerMenus();
      setTreeEntries((prev) => Object.fromEntries(
        Object.entries(prev).filter(([dirPath]) => !isPathRelated(dirPath, entry.path))
      ));
      setExpandedDirs((prev) => prev.filter((dirPath) => !isPathRelated(dirPath, entry.path)));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `Failed to delete ${entry.kind}`);
    }
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

  const updateActiveDoc = useCallback((updater: (doc: OpenDoc) => OpenDoc) => {
    const currentActivePath = activePathRef.current;
    if (!currentActivePath) return;
    setOpenDocs((prev) => prev.map((doc) => (doc.path === currentActivePath ? updater(doc) : doc)));
  }, []);

  const togglePreviewMode = useCallback(() => {
    if (!canTogglePreview) return;
    updateActiveDoc((doc) => ({ ...doc, viewMode: doc.viewMode === 'preview' ? 'edit' : 'preview' }));
  }, [canTogglePreview, updateActiveDoc]);

  const welcomeShortcutItems = useMemo<WelcomeShortcutItem[]>(() => {
    return [
      {
        id: 'copy-entry',
        title: 'Copy Selected',
        description: selectedExplorerEntry ? 'Copy the selected file or folder in Explorer.' : 'Select a file or folder in Explorer, then copy it.',
        keys: ['Mod', 'C'],
        disabled: !selectedExplorerEntry,
        run: () => {
          if (!selectedExplorerEntry) return;
          setCopiedExplorerEntry(selectedExplorerEntry);
          showExplorerToast(`${selectedExplorerEntry.kind === 'dir' ? 'Folder' : 'File'} copied to clipboard`);
        }
      },
      {
        id: 'paste-entry',
        title: 'Paste Into Folder',
        description: copiedExplorerEntry ? 'Paste the copied file or folder into the selected location.' : 'Copy a file or folder first, then paste it into the selected folder.',
        keys: ['Mod', 'V'],
        disabled: !copiedExplorerEntry,
        run: () => void pasteEntry()
      },
      {
        id: 'delete-entry',
        title: 'Delete Selected',
        description: selectedExplorerEntry ? 'Delete the selected file or folder.' : 'Select a file or folder in Explorer, then delete it.',
        keys: isMacLike ? ['Mod', 'Backspace'] : ['Delete'],
        disabled: !selectedExplorerEntry,
        run: () => {
          if (!selectedExplorerEntry) return;
          void deleteEntry(selectedExplorerEntry);
        }
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
        id: 'toggle-explorer',
        title: isExplorerCollapsed ? 'Show Explorer' : 'Hide Explorer',
        description: 'Toggle the left file tree without leaving the editor area.',
        keys: ['Mod', 'B'],
        run: () => toggleExplorerPane()
      },
      {
        id: 'open-project',
        title: 'Open Project',
        description: 'Add or switch a workspace folder in the Explorer.',
        keys: ['Mod', 'O'],
        run: () => void onPickWorkspace()
      }
    ];
  }, [canSave, copiedExplorerEntry, isExplorerCollapsed, isMacLike, onPickWorkspace, pasteEntry, selectedExplorerEntry, showExplorerToast]);

  useEffect(() => {
    function handleWorkspaceShortcut(event: KeyboardEvent) {
      if (event.defaultPrevented) return;

      const panel = panelRef.current;
      const activeElement = document.activeElement;
      if (!panel || !(activeElement instanceof HTMLElement) || !panel.contains(activeElement)) {
        return;
      }

      const key = event.key.toLowerCase();
      const hasMod = event.metaKey || event.ctrlKey;

      if (selectedExplorerEntry && hasMod && !event.altKey && !event.shiftKey && key === 'c') {
        event.preventDefault();
        setCopiedExplorerEntry(selectedExplorerEntry);
        setStatus(selectedExplorerEntry.kind === 'dir' ? 'Folder copied' : 'File copied');
        showExplorerToast(`${selectedExplorerEntry.kind === 'dir' ? 'Folder' : 'File'} copied to clipboard`);
        return;
      }

      if (copiedExplorerEntry && hasMod && !event.altKey && !event.shiftKey && key === 'v') {
        event.preventDefault();
        void pasteEntry();
        return;
      }

      if (selectedExplorerEntry && ((isMacLike && event.metaKey && key === 'backspace') || (!event.metaKey && !event.ctrlKey && !event.altKey && (event.key === 'Delete' || event.key === 'Backspace')))) {
        event.preventDefault();
        void deleteEntry(selectedExplorerEntry);
        return;
      }

      if (!hasMod) return;

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
  }, [copiedExplorerEntry, isMacLike, onPickWorkspace, onSave, onSaveAll, pasteEntry, selectedExplorerEntry, togglePreviewMode]);

  useEffect(() => {
    const off = fsClient.onWorkspaceEvent((event) => {
      if (event.type === 'error') {
        setStatus(event.message);
        return;
      }

      const root = findWorkspaceRootForPath(event.path) ?? workspaceRootRef.current;
      if (!root) return;
      if (root === workspaceRootRef.current) {
        void fsClient.getGitRepository(root)
          .then((repository) => {
            setActiveWorkspaceBranch(repository.gitRoot ? repository.branch : null);
          })
          .catch(() => {
            setActiveWorkspaceBranch(null);
          });
      }
      scheduleWorkspaceRefresh(root, event.path, 'Workspace updated…');
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

  function closeAllDocs() {
    const dirtyDocs = openDocs.filter((doc) => doc.dirty);
    if (dirtyDocs.length) {
      const ok = window.confirm(`Close all tabs? ${dirtyDocs.length} unsaved file${dirtyDocs.length > 1 ? 's' : ''} will be closed without saving.`);
      if (!ok) return;
    }
    setOpenDocs([]);
    setActivePath(null);
    setEditorTabContextMenu(null);
  }

  function closeOtherDocs(targetPath: string) {
    const docsToClose = openDocs.filter((doc) => doc.path !== targetPath);
    const dirtyDocs = docsToClose.filter((doc) => doc.dirty);
    if (dirtyDocs.length) {
      const ok = window.confirm(`Close other tabs? ${dirtyDocs.length} unsaved file${dirtyDocs.length > 1 ? 's' : ''} will be closed without saving.`);
      if (!ok) return;
    }
    const targetDoc = openDocs.find((doc) => doc.path === targetPath);
    setOpenDocs(targetDoc ? [targetDoc] : []);
    setActivePath(targetDoc?.path ?? null);
    setEditorTabContextMenu(null);
  }

  function closeDocsToRight(targetPath: string) {
    const targetIndex = openDocs.findIndex((doc) => doc.path === targetPath);
    if (targetIndex < 0) return;
    const docsToClose = openDocs.slice(targetIndex + 1);
    const dirtyDocs = docsToClose.filter((doc) => doc.dirty);
    if (dirtyDocs.length) {
      const ok = window.confirm(`Close tabs to the right? ${dirtyDocs.length} unsaved file${dirtyDocs.length > 1 ? 's' : ''} will be closed without saving.`);
      if (!ok) return;
    }
    const nextDocs = openDocs.slice(0, targetIndex + 1);
    setOpenDocs(nextDocs);
    if (activePath && !nextDocs.some((doc) => doc.path === activePath)) {
      setActivePath(targetPath);
    }
    setEditorTabContextMenu(null);
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

  useEffect(() => {
    if (!activePath) return;
    requestAnimationFrame(() => {
      const tabsEl = editorTabsRef.current;
      if (!tabsEl) return;
      const target = tabsEl.querySelector<HTMLElement>(`[data-editor-tab-path="${CSS.escape(activePath)}"]`);
      target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }, [activePath, openDocs]);

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
    const isMenuOpen = entryMenuOpenFor === entry.path;
    const isSelected = selectedExplorerEntry?.path === entry.path;

    return (
      <div key={entry.path} className="treeNode">
        <div className="explorerEntryRow">
          <button
            type="button"
            className={[
              isSelected || entry.path === activePath ? 'fileItem active' : isOpen ? 'fileItem open' : 'fileItem',
              flashFilePath === entry.path ? 'flash' : ''
            ].filter(Boolean).join(' ')}
            data-file-path={entry.path}
            onFocus={() => setSelectedExplorerEntry(entry)}
            onContextMenu={(event) => {
              event.preventDefault();
              setSelectedExplorerEntry(entry);
              setExplorerContextMenu({
                x: event.clientX,
                y: event.clientY,
                target: entry,
                mode: 'full'
              });
            }}
            onClick={() => {
              setSelectedExplorerEntry(entry);
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
          <div className="explorerEntryMenuAnchor">
            {entry.kind === 'dir' ? (
              <button
                type="button"
                className="explorerEntryQuickAction"
                onClick={(event) => {
                  event.stopPropagation();
                  setSelectedExplorerEntry(entry);
                  const rect = event.currentTarget.getBoundingClientRect();
                  setExplorerContextMenu({
                    x: rect.right + 6,
                    y: rect.top,
                    target: entry,
                    mode: 'create'
                  });
                }}
                title={`Create in ${entry.name}`}
                aria-label={`Create in ${entry.name}`}
              >
                +
              </button>
            ) : null}
            <button
              type="button"
              className={isMenuOpen ? 'explorerEntryAction active' : 'explorerEntryAction'}
              onClick={(event) => {
                event.stopPropagation();
                setSelectedExplorerEntry(entry);
                setRootMenuOpenFor(null);
                setEntryMenuOpenFor((current) => current === entry.path ? null : entry.path);
              }}
              aria-label={`Actions for ${entry.name}`}
              aria-expanded={isMenuOpen}
              title={`Actions for ${entry.name}`}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 6h.01M12 12h.01M12 18h.01" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
              </svg>
            </button>
            {isMenuOpen ? (
              <div className="workspaceRootMenu explorerEntryMenu" role="menu">
                {entry.kind === 'dir' ? (
                  <>
                    <button type="button" className="workspaceRootMenuItem" onClick={() => void createEntryInDirectory(entry.path, 'file')} role="menuitem">
                      New File
                    </button>
                    <button type="button" className="workspaceRootMenuItem" onClick={() => void createEntryInDirectory(entry.path, 'dir')} role="menuitem">
                      New Folder
                    </button>
                  </>
                ) : null}
                <button type="button" className="workspaceRootMenuItem" onClick={() => void copyEntry(entry)} role="menuitem">
                  Copy
                </button>
                <button type="button" className="workspaceRootMenuItem danger" onClick={() => void deleteEntry(entry)} role="menuitem">
                  Delete
                </button>
              </div>
            ) : null}
          </div>
        </div>
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
        data-workspace-root={root}
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
            onContextMenu={(event) => {
              event.preventDefault();
                setExplorerContextMenu({
                  x: event.clientX,
                  y: event.clientY,
                  target: { name: rootName, path: root, kind: 'root' },
                  mode: 'full'
                });
            }}
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
              onClick={() => {
                setEntryMenuOpenFor(null);
                setRootMenuOpenFor((current) => current === root ? null : root);
              }}
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
              {workspaceRoot ? (
                <>
                  <span className="workspacePathPrimary">
                    <span className="workspacePathProjectName">{activeWorkspaceRootName}</span>
                    {activeWorkspaceBranch ? (
                      <button
                        type="button"
                        className="workspaceBranchBadge"
                        onClick={onOpenGitPage}
                        title={`Open Git page for ${activeWorkspaceBranch}`}
                      >
                        {activeWorkspaceBranch}
                      </button>
                    ) : null}
                    <span>{workspaceRoots.length} project{workspaceRoots.length > 1 ? 's' : ''} open</span>
                    {lastRefreshedAt ? <span className="workspaceRefreshMeta">Refreshed {new Date(lastRefreshedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : null}
                  </span>
                  <span className="workspacePathLocation">{workspaceRoot}</span>
                </>
              ) : 'No project selected'}
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
                className="explorerHeaderRefreshAll"
                onClick={() => void refreshAllWorkspaces()}
                aria-label="Refresh all projects"
                title={workspaceRoots.length ? `Refresh all ${workspaceRoots.length} open project${workspaceRoots.length > 1 ? 's' : ''}` : 'Open a project first'}
                disabled={!workspaceRoots.length || isRefreshingWorkspace}
              >
                <span className={isRefreshingWorkspace ? 'explorerRefreshGlyph spinning' : 'explorerRefreshGlyph'} aria-hidden="true">⟲</span>
              </button>
              <button
                type="button"
                className="explorerHeaderCreate"
                onClick={() => {
                  const targetDir = getExplorerPasteTarget() ?? workspaceRoot;
                  if (!targetDir) return;
                  const targetName = selectedExplorerEntry?.kind === 'dir' ? selectedExplorerEntry.name : activeWorkspaceRootName ?? 'current project';
                  setExplorerContextMenu({
                    x: window.innerWidth > 0 ? Math.min(window.innerWidth - 220, 180) : 180,
                    y: 108,
                    target: { name: targetName, path: targetDir, kind: targetDir === workspaceRoot ? 'root' : 'dir' },
                    mode: 'create'
                  });
                }}
                title={workspaceRoot ? `Create in ${selectedExplorerEntry?.kind === 'dir' ? selectedExplorerEntry.name : activeWorkspaceRootName ?? 'current project'}` : 'Open a project first'}
                aria-label="Create file in current project"
                disabled={!workspaceRoot}
              >
                +
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
              <div className="editorTabs" ref={editorTabsRef}>
                {openDocs.map((doc) => (
                  <div
                    key={doc.path}
                    data-editor-tab-path={doc.path}
                    className={doc.path === activePath ? 'editorTab active' : 'editorTab'}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setEditorTabContextMenu({
                        x: event.clientX,
                        y: event.clientY,
                        path: doc.path
                      });
                    }}
                  >
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
                    <div className="editorPath" title={activeDoc.path}>
                      {activeDoc.path}
                    </div>
                    <div className="editorActions">
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
                          <Suspense fallback={<div className="footerHint">Loading preview…</div>}>
                            <MarkdownPreviewContent markdown={activeDoc.text} />
                          </Suspense>
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

      {explorerContextMenu ? (
        <div className="explorerContextOverlay" onClick={() => setExplorerContextMenu(null)}>
          <div
            className="explorerContextMenu"
            role="menu"
            style={{ left: `${Math.min(explorerContextMenu.x, window.innerWidth - 200)}px`, top: `${Math.min(explorerContextMenu.y, window.innerHeight - 220)}px` }}
            onClick={(event) => event.stopPropagation()}
          >
            {explorerContextMenu.target.kind !== 'file' ? (
              <>
                <button type="button" className="workspaceRootMenuItem" onClick={() => beginCreateEntry(explorerContextMenu.target.path, 'file')} role="menuitem">
                  New File
                </button>
                <button type="button" className="workspaceRootMenuItem" onClick={() => beginCreateEntry(explorerContextMenu.target.path, 'dir')} role="menuitem">
                  New Folder
                </button>
              </>
            ) : null}
            {explorerContextMenu.mode === 'full' && explorerContextMenu.target.kind !== 'root' ? (
              <>
                {explorerContextMenu.target.kind === 'file' ? (
                  <button
                    type="button"
                    className="workspaceRootMenuItem"
                    onClick={() => {
                      if (explorerContextMenu.target.kind === 'file') {
                        void onOpenEntry(explorerContextMenu.target);
                      }
                    }}
                    role="menuitem"
                  >
                    Open
                  </button>
                ) : null}
                <button
                  type="button"
                  className="workspaceRootMenuItem"
                  onClick={() => {
                    if (explorerContextMenu.target.kind === 'root') return;
                    setCopiedExplorerEntry(explorerContextMenu.target);
                    setExplorerContextMenu(null);
                    setStatus(explorerContextMenu.target.kind === 'dir' ? 'Folder copied' : 'File copied');
                    showExplorerToast(`${explorerContextMenu.target.kind === 'dir' ? 'Folder' : 'File'} copied to clipboard`);
                  }}
                  role="menuitem"
                >
                  Copy
                </button>
              </>
            ) : null}
            {explorerContextMenu.mode === 'full' && copiedExplorerEntry && explorerContextMenu.target.kind !== 'file' ? (
              <button
                type="button"
                className="workspaceRootMenuItem"
                onClick={() => {
                  if (explorerContextMenu.target.kind === 'root') {
                    setSelectedExplorerEntry(null);
                  } else {
                    setSelectedExplorerEntry(explorerContextMenu.target);
                  }
                  void pasteEntry(explorerContextMenu.target.kind === 'root' ? explorerContextMenu.target.path : explorerContextMenu.target.path);
                  setExplorerContextMenu(null);
                }}
                role="menuitem"
              >
                Paste
              </button>
            ) : null}
            {explorerContextMenu.mode === 'full' && explorerContextMenu.target.kind === 'root' ? (
              <button type="button" className="workspaceRootMenuItem danger" onClick={() => void removeWorkspaceRoot(explorerContextMenu.target.path)} role="menuitem">
                Remove From Workspace
              </button>
            ) : explorerContextMenu.mode === 'full' ? (
              <button type="button" className="workspaceRootMenuItem danger" onClick={() => explorerContextMenu.target.kind !== 'root' ? void deleteEntry(explorerContextMenu.target) : undefined} role="menuitem">
                Delete
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {editorTabContextMenu ? (
        <div className="explorerContextOverlay" onClick={() => setEditorTabContextMenu(null)}>
          <div
            className="explorerContextMenu editorTabContextMenu"
            role="menu"
            style={{ left: `${Math.min(editorTabContextMenu.x, window.innerWidth - 200)}px`, top: `${Math.min(editorTabContextMenu.y, window.innerHeight - 140)}px` }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="workspaceRootMenuItem"
              onClick={() => {
                closeDoc(editorTabContextMenu.path);
                setEditorTabContextMenu(null);
              }}
              role="menuitem"
            >
              Close
            </button>
            <button
              type="button"
              className="workspaceRootMenuItem"
              onClick={closeAllDocs}
              role="menuitem"
            >
              Close All
            </button>
            <button
              type="button"
              className="workspaceRootMenuItem"
              onClick={() => closeOtherDocs(editorTabContextMenu.path)}
              role="menuitem"
            >
              Close Others
            </button>
            <button
              type="button"
              className="workspaceRootMenuItem"
              onClick={() => closeDocsToRight(editorTabContextMenu.path)}
              role="menuitem"
            >
              Close Tabs to the Right
            </button>
          </div>
        </div>
      ) : null}

      {explorerInputState ? (
        <div className="settingsHelpOverlay explorerInputOverlay" onClick={() => setExplorerInputState(null)}>
          <div className="settingsHelpDialog explorerInputDialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="settingsHelpDialogHeader">
              <div className="settingsHelpDialogTitle">{explorerInputState.title}</div>
              <button type="button" className="settingsHelpCloseButton" aria-label="Close" onClick={() => setExplorerInputState(null)}>
                &times;
              </button>
            </div>
            <form
              className="explorerInputForm"
              onSubmit={(event) => {
                event.preventDefault();
                void submitExplorerInput();
              }}
            >
              <div className="explorerInputMeta">{explorerInputState.targetDir}</div>
              <input
                ref={explorerInputRef}
                className="explorerInputField"
                value={explorerInputState.value}
                onChange={(event) => setExplorerInputState((current) => current ? { ...current, value: event.target.value } : current)}
                placeholder={explorerInputState.mode === 'create-dir' ? 'new-folder' : 'untitled.txt'}
              />
              <div className="explorerInputActions">
                <button type="button" onClick={() => setExplorerInputState(null)}>Cancel</button>
                <button type="submit">{explorerInputState.confirmLabel}</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {explorerToast ? (
        <div className="explorerToast" role="status" aria-live="polite">
          {explorerToast}
        </div>
      ) : null}
    </div>
  );
});
