import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fsClient, type GitCommitResult, type GitDiffSnapshot, type GitRepositorySnapshot, type GitStatusEntry } from '../fsClient';

function getNameFromPath(targetPath: string) {
  return targetPath.split(/[\\/]/).filter(Boolean).pop() ?? targetPath;
}

function quoteShellArg(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatGitCode(entry: GitStatusEntry) {
  if (entry.staged === '?' && entry.unstaged === '?') return '??';
  return `${entry.staged}${entry.unstaged}`;
}

function formatGitKind(kind: GitStatusEntry['kind']) {
  if (kind === 'added') return 'Added';
  if (kind === 'modified') return 'Modified';
  if (kind === 'deleted') return 'Deleted';
  if (kind === 'renamed') return 'Renamed';
  if (kind === 'copied') return 'Copied';
  if (kind === 'typechange') return 'Type change';
  if (kind === 'untracked') return 'Untracked';
  if (kind === 'unmerged') return 'Unmerged';
  return 'Changed';
}

type GitSelection = {
  workspaceRoot: string;
  path: string;
  staged: boolean;
} | null;

function sameSelection(left: GitSelection, right: GitSelection) {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.workspaceRoot === right.workspaceRoot && left.path === right.path && left.staged === right.staged;
}

function groupRepositoryEntries(repository: GitRepositorySnapshot) {
  const staged = repository.statusEntries.filter((entry) => entry.staged !== ' ' && entry.staged !== '?');
  const unstaged = repository.statusEntries.filter((entry) => entry.unstaged !== ' ' || entry.kind === 'untracked');
  return { staged, unstaged };
}

function formatDiffText(diff: GitDiffSnapshot | null) {
  if (!diff) return '';
  if (!diff.diff.trim()) {
    return diff.staged ? 'No staged diff for the selected file.' : 'No unstaged diff for the selected file.';
  }
  return diff.diff;
}

export function GitPage(props: {
  onRunCommandInTerminal: (command: string, timeoutMs?: number) => Promise<unknown>;
}) {
  const { onRunCommandInTerminal } = props;
  const [repositories, setRepositories] = useState<GitRepositorySnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeWorkspaceRoot, setActiveWorkspaceRoot] = useState<string | null>(null);
  const [selection, setSelection] = useState<GitSelection>(null);
  const [diffSnapshot, setDiffSnapshot] = useState<GitDiffSnapshot | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [commitOutput, setCommitOutput] = useState<string | null>(null);
  const refreshTimerRef = useRef<number | null>(null);

  const loadRepositories = useCallback(async (showSpinner = true) => {
    if (showSpinner) {
      setLoading(true);
    }
    try {
      const nextRepositories = await fsClient.getGitRepositories();
      setRepositories(nextRepositories);
      setError(null);
      setActiveWorkspaceRoot((prev) => {
        if (prev && nextRepositories.some((repository) => repository.workspaceRoot === prev)) {
          return prev;
        }
        return nextRepositories.find((repository) => repository.gitRoot)?.workspaceRoot ?? nextRepositories[0]?.workspaceRoot ?? null;
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to load Git repositories.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRepositories();
  }, [loadRepositories]);

  useEffect(() => {
    const dispose = fsClient.onWorkspaceEvent(() => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        void loadRepositories(false);
      }, 320);
    });

    return () => {
      dispose();
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
    };
  }, [loadRepositories]);

  const repoCount = useMemo(() => repositories.filter((repository) => repository.gitRoot).length, [repositories]);

  const activeRepository = useMemo(() => {
    if (!activeWorkspaceRoot) return null;
    return repositories.find((repository) => repository.workspaceRoot === activeWorkspaceRoot) ?? null;
  }, [repositories, activeWorkspaceRoot]);

  const repoGroups = useMemo(() => {
    if (!activeRepository) {
      return { staged: [], unstaged: [] } as { staged: GitStatusEntry[]; unstaged: GitStatusEntry[] };
    }
    return groupRepositoryEntries(activeRepository);
  }, [activeRepository]);

  useEffect(() => {
    if (!activeRepository?.gitRoot) {
      setSelection((prev) => (prev === null ? prev : null));
      setDiffSnapshot(null);
      return;
    }

    if (selection && selection.workspaceRoot === activeRepository.workspaceRoot) {
      const existing = activeRepository.statusEntries.find((entry) => entry.path === selection.path);
      if (existing) {
        const nextStaged = selection.staged && existing.staged !== ' ' && existing.staged !== '?';
        const nextUnstaged = !selection.staged && (existing.unstaged !== ' ' || existing.kind === 'untracked');
        if (nextStaged || nextUnstaged) {
          return;
        }
      }
    }

    const firstStaged = repoGroups.staged[0];
    if (firstStaged) {
      const nextSelection = { workspaceRoot: activeRepository.workspaceRoot, path: firstStaged.path, staged: true };
      setSelection((prev) => (sameSelection(prev, nextSelection) ? prev : nextSelection));
      return;
    }

    const firstUnstaged = repoGroups.unstaged[0];
    if (firstUnstaged) {
      const nextSelection = { workspaceRoot: activeRepository.workspaceRoot, path: firstUnstaged.path, staged: false };
      setSelection((prev) => (sameSelection(prev, nextSelection) ? prev : nextSelection));
      return;
    }

    setSelection((prev) => (prev === null ? prev : null));
    setDiffSnapshot(null);
  }, [activeRepository, repoGroups.staged, repoGroups.unstaged, selection]);

  useEffect(() => {
    if (!selection) {
      setDiffSnapshot(null);
      return;
    }

    let cancelled = false;
    setActionError(null);
    setDiffLoading(true);

    void fsClient.getGitDiff(selection.workspaceRoot, selection.path, selection.staged)
      .then((snapshot) => {
        if (!cancelled) {
          setDiffSnapshot(snapshot);
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setActionError(nextError instanceof Error ? nextError.message : 'Unable to load diff.');
          setDiffSnapshot(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDiffLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selection]);

  const selectedEntry = useMemo(() => {
    if (!activeRepository || !selection || selection.workspaceRoot !== activeRepository.workspaceRoot) return null;
    return activeRepository.statusEntries.find((entry) => entry.path === selection.path) ?? null;
  }, [activeRepository, selection]);

  async function runGitCommand(repository: GitRepositorySnapshot, command: string, actionKey: string) {
    setActiveAction(actionKey);
    try {
      await onRunCommandInTerminal(`cd ${quoteShellArg(repository.workspaceRoot)} && ${command}`, 20000);
    } finally {
      setActiveAction(null);
    }
  }

  async function applyRepositoryResult(result: GitRepositorySnapshot | GitCommitResult) {
    if ('repository' in result) {
      setRepositories((prev) => prev.map((repository) => repository.workspaceRoot === result.repository.workspaceRoot ? result.repository : repository));
      setCommitOutput(result.output);
      setCommitMessage('');
      return;
    }

    setRepositories((prev) => prev.map((repository) => repository.workspaceRoot === result.workspaceRoot ? result : repository));
  }

  async function withRepositoryAction(actionKey: string, action: () => Promise<GitRepositorySnapshot | GitCommitResult>) {
    setActiveAction(actionKey);
    setActionError(null);
    setCommitOutput(null);
    try {
      const result = await action();
      await applyRepositoryResult(result);
    } catch (nextError) {
      setActionError(nextError instanceof Error ? nextError.message : 'Git action failed.');
    } finally {
      setActiveAction(null);
    }
  }

  const canCommit = !!activeRepository?.gitRoot && activeRepository.stagedFiles > 0 && commitMessage.trim().length > 0 && activeAction === null;

  return (
    <div className="page gitWorkbenchPage">
      <div className="pageHeader">
        <div>
          <div className="pageTitle">Git</div>
          <div className="pageSubtitle">JetBrains-style local changes workflow with staged files, diff preview, and commit controls.</div>
        </div>
        <div className="gitWorkbenchHeaderActions">
          <div className="pill" style={{ opacity: 1 }}>{repoCount} repo{repoCount === 1 ? '' : 's'}</div>
          {activeRepository?.branch ? <div className="pill" style={{ opacity: 1 }}>Branch: {activeRepository.branch}</div> : null}
          {loading ? <div className="pill" style={{ opacity: 1 }}>Refreshing</div> : null}
          <button type="button" className="gitActionButton" onClick={() => void loadRepositories()}>
            Refresh All
          </button>
        </div>
      </div>

      {error ? <div className="card gitEmptyState">{error}</div> : null}
      {actionError ? <div className="card gitEmptyState">{actionError}</div> : null}

      {!loading && repositories.length === 0 ? <div className="card gitEmptyState">Open a workspace folder to inspect Git repositories.</div> : null}

      <div className="gitWorkbenchLayout">
        <aside className="card gitSidebarPane">
          <div className="gitPaneHeader">
            <div>
              <div className="cardTitle">Repositories</div>
              <div className="gitPaneHint">Opened workspace roots</div>
            </div>
          </div>

          <div className="gitRepoList">
            {repositories.map((repository) => {
              const repoName = repository.gitRoot ? getNameFromPath(repository.gitRoot) : getNameFromPath(repository.workspaceRoot);
              const selected = repository.workspaceRoot === activeWorkspaceRoot;
              return (
                <button
                  key={repository.workspaceRoot}
                  type="button"
                  className={selected ? 'gitRepoListItem active' : 'gitRepoListItem'}
                  onClick={() => setActiveWorkspaceRoot(repository.workspaceRoot)}
                >
                  <span className="gitRepoListTitle">{repoName}</span>
                  <span className="gitRepoListMeta">{repository.gitRoot ? (repository.branch ?? 'No branch') : 'Not a Git repo'}</span>
                  <span className="gitRepoListMeta">{repository.gitRoot ? `${repository.changedFiles} change${repository.changedFiles === 1 ? '' : 's'}` : repository.workspaceRoot}</span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="card gitChangesPane">
          <div className="gitPaneHeader split">
            <div>
              <div className="cardTitle">Local Changes</div>
              <div className="gitPaneHint">Inspect and move files between the index and working tree.</div>
            </div>
            <div className="gitPaneHeaderMeta">
              {activeRepository?.headShortSha ? <div className="pill" style={{ opacity: 1 }}>HEAD: {activeRepository.headShortSha}</div> : null}
              {activeRepository?.upstream ? <div className="pill" style={{ opacity: 1 }}>{activeRepository.upstream}</div> : null}
            </div>
          </div>

          {!activeRepository ? (
            <div className="gitEmptyState">Select a repository from the left panel.</div>
          ) : !activeRepository.gitRoot ? (
            <div className="gitEmptyState">This workspace is not currently inside a Git repository.</div>
          ) : activeRepository.error ? (
            <div className="gitEmptyState">{activeRepository.error}</div>
          ) : (
            <div className="gitChangesColumns">
              <div className="gitChangeGroup">
                <div className="gitGroupHeader">
                  <span>Staged</span>
                  <span>{repoGroups.staged.length}</span>
                </div>

                <div className="gitChangeList">
                  {repoGroups.staged.length === 0 ? <div className="gitEmptyState compact">Nothing staged.</div> : null}
                  {repoGroups.staged.map((entry) => (
                    <div key={`staged:${entry.path}`} className={selection?.path === entry.path && selection.staged ? 'gitChangeItem active' : 'gitChangeItem'}>
                      <button
                        type="button"
                        className="gitChangeMain"
                        onClick={() => setSelection({ workspaceRoot: activeRepository.workspaceRoot, path: entry.path, staged: true })}
                      >
                        <span className="gitStatusCode">{formatGitCode(entry)}</span>
                        <span className="gitChangeTextBlock">
                          <span className="gitStatusPath">{entry.path}</span>
                          <span className="gitStatusMeta">
                            {formatGitKind(entry.kind)}
                            {entry.originalPath ? ` · ${entry.originalPath} -> ${entry.path}` : ''}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="gitInlineAction"
                        onClick={() => void withRepositoryAction(`unstage:${entry.path}`, () => fsClient.unstageGitFile(activeRepository.workspaceRoot, entry.path))}
                        disabled={activeAction !== null}
                      >
                        Unstage
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="gitChangeGroup">
                <div className="gitGroupHeader">
                  <span>Unstaged</span>
                  <span>{repoGroups.unstaged.length}</span>
                </div>

                <div className="gitChangeList">
                  {repoGroups.unstaged.length === 0 ? <div className="gitEmptyState compact">Working tree is clean.</div> : null}
                  {repoGroups.unstaged.map((entry) => (
                    <div key={`unstaged:${entry.path}`} className={selection?.path === entry.path && !selection.staged ? 'gitChangeItem active' : 'gitChangeItem'}>
                      <button
                        type="button"
                        className="gitChangeMain"
                        onClick={() => setSelection({ workspaceRoot: activeRepository.workspaceRoot, path: entry.path, staged: false })}
                      >
                        <span className="gitStatusCode">{formatGitCode(entry)}</span>
                        <span className="gitChangeTextBlock">
                          <span className="gitStatusPath">{entry.path}</span>
                          <span className="gitStatusMeta">
                            {formatGitKind(entry.kind)}
                            {entry.originalPath ? ` · ${entry.originalPath} -> ${entry.path}` : ''}
                          </span>
                        </span>
                      </button>
                      <div className="gitInlineActions">
                        <button
                          type="button"
                          className="gitInlineAction"
                          onClick={() => void withRepositoryAction(`stage:${entry.path}`, () => fsClient.stageGitFile(activeRepository.workspaceRoot, entry.path))}
                          disabled={activeAction !== null}
                        >
                          Stage
                        </button>
                        <button
                          type="button"
                          className="gitInlineAction danger"
                          onClick={() => void withRepositoryAction(`discard:${entry.path}`, () => fsClient.discardGitFile(activeRepository.workspaceRoot, entry.path))}
                          disabled={activeAction !== null}
                        >
                          Discard
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="card gitDiffPane">
          <div className="gitPaneHeader split">
            <div>
              <div className="cardTitle">Diff</div>
              <div className="gitPaneHint">Focused preview for the selected file</div>
            </div>
            {selectedEntry ? <div className="pill" style={{ opacity: 1 }}>{selection?.staged ? 'Staged diff' : 'Working tree diff'}</div> : null}
          </div>

          {!selection ? (
            <div className="gitEmptyState">Select a changed file to preview its diff.</div>
          ) : diffLoading ? (
            <div className="gitEmptyState">Loading diff…</div>
          ) : (
            <>
              <div className="gitDiffMeta">
                <strong>{selection.path}</strong>
                {selectedEntry ? <span>{formatGitKind(selectedEntry.kind)}</span> : null}
              </div>
              <pre className="gitDiffViewer">{formatDiffText(diffSnapshot)}</pre>
            </>
          )}
        </section>

        <aside className="card gitCommitPane">
          <div className="gitPaneHeader split">
            <div>
              <div className="cardTitle">Commit</div>
              <div className="gitPaneHint">Create a commit from staged changes</div>
            </div>
            {activeRepository?.gitRoot ? (
              <button
                type="button"
                className="gitActionButton"
                onClick={() => void runGitCommand(activeRepository, 'git status -sb && git log --oneline -n 8', `${activeRepository.workspaceRoot}:terminal`)}
                disabled={activeAction !== null}
              >
                Open in Terminal
              </button>
            ) : null}
          </div>

          {activeRepository?.gitRoot ? (
            <>
              <textarea
                className="gitCommitInput"
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                placeholder="Commit message"
                rows={5}
              />

              <div className="gitCommitStats">
                <div className="pill" style={{ opacity: 1 }}>Staged: {activeRepository.stagedFiles}</div>
                <div className="pill" style={{ opacity: 1 }}>Unstaged: {activeRepository.unstagedFiles}</div>
                {activeRepository.untrackedFiles > 0 ? <div className="pill" style={{ opacity: 1 }}>Untracked: {activeRepository.untrackedFiles}</div> : null}
                {!activeRepository.isClean && activeRepository.ahead > 0 ? <div className="pill" style={{ opacity: 1 }}>Ahead: {activeRepository.ahead}</div> : null}
                {!activeRepository.isClean && activeRepository.behind > 0 ? <div className="pill" style={{ opacity: 1 }}>Behind: {activeRepository.behind}</div> : null}
              </div>

              <div className="gitCommitActions">
                <button
                  type="button"
                  className="gitActionButton"
                  onClick={() => void withRepositoryAction('commit', () => fsClient.commitGitChanges(activeRepository.workspaceRoot, commitMessage))}
                  disabled={!canCommit}
                >
                  Commit
                </button>
                <button
                  type="button"
                  className="gitActionButton"
                  onClick={() => void withRepositoryAction(`refresh:${activeRepository.workspaceRoot}`, () => fsClient.getGitRepository(activeRepository.workspaceRoot))}
                  disabled={activeAction !== null}
                >
                  Refresh Repo
                </button>
              </div>

              {commitOutput ? <div className="gitCommitOutput">{commitOutput}</div> : null}
            </>
          ) : (
            <div className="gitEmptyState">Select a Git repository to prepare commits.</div>
          )}

          <div className="gitPaneHeader" style={{ marginTop: 6 }}>
            <div>
              <div className="cardTitle">Recent commits</div>
              <div className="gitPaneHint">Latest 5 for the selected repository</div>
            </div>
          </div>

          <div className="gitCommitHistory">
            {!activeRepository?.recentCommits.length ? <div className="gitEmptyState compact">No recent commits available.</div> : null}
            {activeRepository?.recentCommits.map((commit) => (
              <div key={commit.sha} className="gitCommitHistoryItem">
                <div className="gitCommitHeader">
                  <strong>{commit.shortSha}</strong>
                  <span>{commit.relativeTime}</span>
                </div>
                <div className="gitCommitSubject">{commit.subject}</div>
                <div className="gitCommitMeta">{commit.author}</div>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}