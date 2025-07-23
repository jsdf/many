import React, { useState, useCallback } from "react";
import { Worktree, TerminalConfig, WorktreeTerminals } from "../types";
import TilingLayout, { Tile } from "./TilingLayout";
import Terminal from "./Terminal";

const formatBranchName = (branch?: string) => {
  if (!branch) return "detached HEAD";
  return branch.replace(/^refs\/heads\//, "");
};

interface MainContentProps {
  selectedWorktree: Worktree | null;
  currentRepo: string | null;
  onArchiveWorktree: (worktree: Worktree) => Promise<void>;
  onMergeWorktree: (worktree: Worktree) => void;
  onRebaseWorktree: (worktree: Worktree) => void;
}

interface WorktreeDetailsProps {
  worktree: Worktree;
  onArchiveWorktree: (worktree: Worktree) => Promise<void>;
  onMergeWorktree: (worktree: Worktree) => void;
  onRebaseWorktree: (worktree: Worktree) => void;
}

const WorktreeDetails: React.FC<WorktreeDetailsProps> = ({
  worktree,
  onArchiveWorktree,
  onMergeWorktree,
  onRebaseWorktree,
}) => {
  const [isLoading, setIsLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleAction = async (
    action: string,
    actionFn: () => Promise<boolean | void>
  ) => {
    setIsLoading(action);
    setError(null);

    try {
      await actionFn();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Action failed");
    } finally {
      setIsLoading(null);
    }
  };

  const archiveWorktree = async () => {
    const confirmed = confirm(
      `Are you sure you want to archive the worktree "${formatBranchName(
        worktree.branch
      )}"?\n\nThis will remove the working directory but keep the branch in git.`
    );
    if (!confirmed) return;

    await handleAction("archive", async () => {
      await onArchiveWorktree(worktree);
    });
  };

  const mergeWorktree = () => {
    onMergeWorktree(worktree);
  };

  const rebaseWorktree = () => {
    onRebaseWorktree(worktree);
  };

  return (
    <div className="worktree-details-content">
      <div className="worktree-info">
        <h2>Worktree Overview</h2>
        <div className="info-grid">
          <div className="info-item">
            <label>Path:</label>
            <span>{worktree.path}</span>
          </div>
          <div className="info-item">
            <label>Branch:</label>
            <span>{worktree.branch || "detached HEAD"}</span>
          </div>
        </div>
      </div>

      <div className="worktree-actions">
        <h3>Quick Actions</h3>
        <div className="action-buttons">
          <button
            className="btn btn-secondary"
            onClick={() => {
              window.electronAPI?.openInFileManager?.(worktree.path);
            }}
          >
            📁 Open Folder
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => {
              window.electronAPI?.openInEditor?.(worktree.path);
            }}
          >
            📝 Open in Editor
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => {
              window.electronAPI?.openInTerminal?.(worktree.path);
            }}
          >
            💻 Open in Terminal
          </button>
        </div>

        {error && <p className="error-message">{error}</p>}
      </div>

      <div className="worktree-management-actions">
        <h3>Worktree Management</h3>
        <div className="management-buttons">
          <button
            className="btn btn-success"
            onClick={mergeWorktree}
            disabled={!worktree?.branch}
          >
            🔀 Merge Changes
          </button>

          <button
            className="btn btn-info"
            onClick={rebaseWorktree}
            disabled={!worktree?.branch}
          >
            🌿 Rebase Branch
          </button>

          <button
            className="btn btn-warning"
            onClick={archiveWorktree}
            disabled={isLoading === "archive"}
          >
            📦 {isLoading === "archive" ? "Archiving..." : "Archive Worktree"}
          </button>
        </div>
      </div>

      <div className="git-status">
        <h3>Git Status</h3>
        <div className="status-info">
          <p>Changes will appear here...</p>
        </div>
      </div>
    </div>
  );
};

// Global state to maintain terminals across worktree switches
const globalTerminalState = new Map<string, {
  tiles: Tile[];
  terminalConfig: WorktreeTerminals;
}>();

// Function to clean up worktree from global state
const cleanupWorktreeState = (worktreePath: string) => {
  console.log(`Cleaning up terminal state for worktree: ${worktreePath}`);
  globalTerminalState.delete(worktreePath);
};

const MainContent: React.FC<MainContentProps> = ({
  selectedWorktree,
  onArchiveWorktree,
  onMergeWorktree,
  onRebaseWorktree,
}) => {
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [isLoadingTerminals, setIsLoadingTerminals] = useState(false);

  // Switch to worktree's terminal state or initialize if needed
  React.useEffect(() => {
    const loadWorktreeTerminals = async () => {
      if (!selectedWorktree) {
        setTiles([]);
        return;
      }

      setIsLoadingTerminals(true);
      try {
        // Check if we already have this worktree's terminals in global state
        let worktreeState = globalTerminalState.get(selectedWorktree.path);
        
        if (!worktreeState) {
          // Initialize new worktree state
          const savedConfig = await window.electronAPI.getWorktreeTerminals(selectedWorktree.path);
          
          // Create main content tile
          const mainContentTile: Tile = {
            id: `main-content-${selectedWorktree.path}`,
            type: "content",
            title: "Worktree Details",
            component: (
              <WorktreeDetails
                worktree={selectedWorktree}
                onArchiveWorktree={onArchiveWorktree}
                onMergeWorktree={onMergeWorktree}
                onRebaseWorktree={onRebaseWorktree}
              />
            ),
          };

          const terminalTiles: Tile[] = [];
          
          if (savedConfig.terminals.length === 0) {
            // Create default terminal if none exist
            const defaultTerminal: TerminalConfig = {
              id: `${selectedWorktree.path}-terminal-1`,
              title: "Terminal 1",
              type: "terminal",
            };
            
            const defaultTile: Tile = {
              id: defaultTerminal.id,
              type: "terminal",
              title: defaultTerminal.title,
              component: (
                <Terminal
                  workingDirectory={selectedWorktree.path}
                  terminalId={defaultTerminal.id}
                  onTitleChange={(title) => updateTileTitle(defaultTerminal.id, title)}
                  initialCommand={defaultTerminal.initialCommand}
                  worktreePath={selectedWorktree.path}
                />
              ),
            };
            terminalTiles.push(defaultTile);
            
            // Save the default terminal
            const newConfig = {
              terminals: [defaultTerminal],
              nextTerminalId: 2,
            };
            await window.electronAPI.saveWorktreeTerminals(selectedWorktree.path, newConfig);
            
            worktreeState = {
              tiles: [mainContentTile, ...terminalTiles],
              terminalConfig: newConfig,
            };
          } else {
            // Restore saved terminals
            for (const terminal of savedConfig.terminals) {
              const tile: Tile = {
                id: terminal.id,
                type: "terminal",
                title: terminal.title,
                component: (
                  <Terminal
                    workingDirectory={selectedWorktree.path}
                    terminalId={terminal.id}
                    onTitleChange={(title) => updateTileTitle(terminal.id, title)}
                    initialCommand={terminal.initialCommand}
                    worktreePath={selectedWorktree.path}
                  />
                ),
              };
              terminalTiles.push(tile);
            }
            
            worktreeState = {
              tiles: [mainContentTile, ...terminalTiles],
              terminalConfig: savedConfig,
            };
          }
          
          // Store in global state
          globalTerminalState.set(selectedWorktree.path, worktreeState);
        }
        
        // Set tiles to the worktree's state
        setTiles(worktreeState.tiles);
        
      } catch (error) {
        console.error("Failed to load worktree terminals:", error);
        // Fallback to basic setup
        const mainContentTile: Tile = {
          id: `main-content-${selectedWorktree.path}`,
          type: "content",
          title: "Worktree Details",
          component: (
            <WorktreeDetails
              worktree={selectedWorktree}
              onArchiveWorktree={onArchiveWorktree}
              onMergeWorktree={onMergeWorktree}
              onRebaseWorktree={onRebaseWorktree}
            />
          ),
        };
        setTiles([mainContentTile]);
      } finally {
        setIsLoadingTerminals(false);
      }
    };

    loadWorktreeTerminals();
  }, [selectedWorktree, onArchiveWorktree, onMergeWorktree, onRebaseWorktree]);

  const updateTileTitle = useCallback((tileId: string, newTitle: string) => {
    if (!selectedWorktree) return;
    
    // Update local tiles
    setTiles((prevTiles) =>
      prevTiles.map((tile) =>
        tile.id === tileId ? { ...tile, title: newTitle } : tile
      )
    );
    
    // Update global state
    const worktreeState = globalTerminalState.get(selectedWorktree.path);
    if (worktreeState) {
      worktreeState.tiles = worktreeState.tiles.map((tile) =>
        tile.id === tileId ? { ...tile, title: newTitle } : tile
      );
      globalTerminalState.set(selectedWorktree.path, worktreeState);
    }
  }, [selectedWorktree]);

  const handleCloseTile = useCallback(async (tileId: string) => {
    if (!selectedWorktree) return;

    // Update local tiles
    setTiles((prevTiles) => prevTiles.filter((tile) => tile.id !== tileId));

    // If it's a terminal, clean up the session and update persistent state
    if (tileId.includes("terminal-") || tileId.includes("claude-")) {
      window.electronAPI.closeTerminal?.(tileId);
      
      // Update global state
      const worktreeState = globalTerminalState.get(selectedWorktree.path);
      if (worktreeState) {
        worktreeState.tiles = worktreeState.tiles.filter((tile) => tile.id !== tileId);
        worktreeState.terminalConfig.terminals = worktreeState.terminalConfig.terminals.filter(t => t.id !== tileId);
        globalTerminalState.set(selectedWorktree.path, worktreeState);
        
        // Save to persistent storage
        await window.electronAPI.saveWorktreeTerminals(selectedWorktree.path, worktreeState.terminalConfig);
      }
    }
  }, [selectedWorktree]);

  const handleSplitTile = useCallback(
    async (tileId: string, direction: "horizontal" | "vertical") => {
      if (!selectedWorktree) return;

      const worktreeState = globalTerminalState.get(selectedWorktree.path);
      if (!worktreeState) return;
      
      const newTerminalId = `${selectedWorktree.path}-terminal-${worktreeState.terminalConfig.nextTerminalId}`;
      const newTerminal: TerminalConfig = {
        id: newTerminalId,
        title: `Terminal ${worktreeState.terminalConfig.nextTerminalId}`,
        type: "terminal",
      };
      
      const newTile: Tile = {
        id: newTerminalId,
        type: "terminal",
        title: newTerminal.title,
        component: (
          <Terminal
            workingDirectory={selectedWorktree.path}
            terminalId={newTerminalId}
            onTitleChange={(title) => updateTileTitle(newTerminalId, title)}
            worktreePath={selectedWorktree.path}
          />
        ),
      };

      // Update local tiles
      setTiles((prevTiles) => [...prevTiles, newTile]);
      
      // Update global state
      worktreeState.tiles.push(newTile);
      worktreeState.terminalConfig.terminals.push(newTerminal);
      worktreeState.terminalConfig.nextTerminalId += 1;
      globalTerminalState.set(selectedWorktree.path, worktreeState);
      
      // Save to persistent storage
      await window.electronAPI.saveWorktreeTerminals(selectedWorktree.path, worktreeState.terminalConfig);
    },
    [selectedWorktree, updateTileTitle]
  );

  const handleAddClaudeTerminal = useCallback(async () => {
    if (!selectedWorktree) return;

    const worktreeState = globalTerminalState.get(selectedWorktree.path);
    if (!worktreeState) return;

    const claudeTerminalId = `${selectedWorktree.path}-claude-${worktreeState.terminalConfig.nextTerminalId}`;
    const claudeTerminal: TerminalConfig = {
      id: claudeTerminalId,
      title: "Claude Terminal",
      type: "claude",
      initialCommand: "claude",
    };
    
    const claudeTile: Tile = {
      id: claudeTerminalId,
      type: "terminal",
      title: claudeTerminal.title,
      component: (
        <Terminal
          workingDirectory={selectedWorktree.path}
          terminalId={claudeTerminalId}
          onTitleChange={(title) => updateTileTitle(claudeTerminalId, title)}
          initialCommand={claudeTerminal.initialCommand}
          worktreePath={selectedWorktree.path}
        />
      ),
    };

    // Update local tiles
    setTiles((prevTiles) => [...prevTiles, claudeTile]);
    
    // Update global state
    worktreeState.tiles.push(claudeTile);
    worktreeState.terminalConfig.terminals.push(claudeTerminal);
    worktreeState.terminalConfig.nextTerminalId += 1;
    globalTerminalState.set(selectedWorktree.path, worktreeState);
    
    // Save to persistent storage
    await window.electronAPI.saveWorktreeTerminals(selectedWorktree.path, worktreeState.terminalConfig);
  }, [selectedWorktree, updateTileTitle]);

  if (!selectedWorktree) {
    return (
      <div className="main-content">
        <div className="welcome">
          <h1>Many Worktree Manager</h1>
          <p>Manage git worktrees for parallel development with AI tools</p>
          <div className="features">
            <div className="feature">
              <h3>🌿 Multiple Worktrees</h3>
              <p>Work on different features simultaneously</p>
            </div>
            <div className="feature">
              <h3>🤖 AI Integration</h3>
              <p>Generate branch names from prompts</p>
            </div>
            <div className="feature">
              <h3>⚡ Quick Setup</h3>
              <p>Create worktrees with a single click</p>
            </div>
            <div className="feature">
              <h3>💻 Integrated Terminals</h3>
              <p>Built-in terminal with tiling layout</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="main-content worktree-view">
      <div className="worktree-header">
        <div className="worktree-title">
          <h2>{selectedWorktree.branch || "Worktree"}</h2>
          <span className="worktree-path">{selectedWorktree.path}</span>
        </div>
        <div className="worktree-controls">
          <button
            className="btn btn-secondary"
            onClick={() => handleSplitTile("", "horizontal")}
            title="Add terminal"
          >
            + Terminal
          </button>
          <button
            className="btn btn-primary"
            onClick={() => handleAddClaudeTerminal()}
            title="Open Claude terminal"
          >
            🤖 Claude
          </button>
        </div>
      </div>

      <div className="tiling-container">
        <TilingLayout
          tiles={tiles}
          onCloseTile={handleCloseTile}
          onSplitTile={handleSplitTile}
        />
      </div>
    </div>
  );
};

export default MainContent;
export { cleanupWorktreeState };
