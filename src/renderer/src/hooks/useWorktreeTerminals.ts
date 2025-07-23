import { useState, useCallback, useEffect } from "react";
import { Worktree, TerminalConfig, WorktreeTerminals } from "../types";

// Global state to maintain only terminal configurations across worktree switches
const globalTerminalState = new Map<string, WorktreeTerminals>();

// Function to clean up worktree from global state
export const cleanupWorktreeState = (worktreePath: string) => {
  globalTerminalState.delete(worktreePath);
};

interface UseWorktreeTerminalsProps {
  selectedWorktree: Worktree | null;
}

export interface TileData {
  id: string;
  type: "terminal";
  title: string;
  terminalConfig: TerminalConfig;
}

export const useWorktreeTerminals = ({
  selectedWorktree,
}: UseWorktreeTerminalsProps) => {
  const [terminalConfig, setTerminalConfig] = useState<WorktreeTerminals>({
    terminals: [],
    nextTerminalId: 1,
  });
  const [isLoadingTerminals, setIsLoadingTerminals] = useState(false);

  // Function to update tile title
  const updateTileTitle = useCallback(
    (tileId: string, newTitle: string) => {
      if (!selectedWorktree) return;

      // Update local config
      setTerminalConfig((prev) => ({
        ...prev,
        terminals: prev.terminals.map((terminal) =>
          terminal.id === tileId ? { ...terminal, title: newTitle } : terminal
        ),
      }));

      // Update global state
      const globalConfig = globalTerminalState.get(selectedWorktree.path);
      if (globalConfig) {
        globalConfig.terminals = globalConfig.terminals.map((terminal) =>
          terminal.id === tileId ? { ...terminal, title: newTitle } : terminal
        );
        globalTerminalState.set(selectedWorktree.path, globalConfig);
      }
    },
    [selectedWorktree]
  );

  // Load terminal configuration for the selected worktree
  useEffect(() => {
    const loadWorktreeTerminals = async () => {
      if (!selectedWorktree) {
        setTerminalConfig({ terminals: [], nextTerminalId: 1 });
        return;
      }

      setIsLoadingTerminals(true);
      try {
        // Check if we already have this worktree's terminal config in global state
        let config = globalTerminalState.get(selectedWorktree.path);

        if (!config) {
          // Load from persistent storage
          config = await window.electronAPI.getWorktreeTerminals(
            selectedWorktree.path
          );

          if (config.terminals.length === 0) {
            // Create default terminal if none exist
            const defaultTerminal: TerminalConfig = {
              id: `${selectedWorktree.path}-terminal-1`,
              title: "Terminal 1",
              type: "terminal",
            };

            config = {
              terminals: [defaultTerminal],
              nextTerminalId: 2,
            };

            // Save the default terminal
            await window.electronAPI.saveWorktreeTerminals(
              selectedWorktree.path,
              config
            );
          }

          // Store in global state
          globalTerminalState.set(selectedWorktree.path, config);
        }

        setTerminalConfig(config);
      } catch (error) {
        console.error("Failed to load worktree terminals:", error);
        // Fallback to basic setup
        setTerminalConfig({ terminals: [], nextTerminalId: 1 });
      } finally {
        setIsLoadingTerminals(false);
      }
    };

    loadWorktreeTerminals();
  }, [selectedWorktree]);

  // Generate terminal tile data only
  const terminalTileData: TileData[] = [];

  if (selectedWorktree) {
    // Add terminal tile data
    for (const terminal of terminalConfig.terminals) {
      terminalTileData.push({
        id: terminal.id,
        type: "terminal",
        title: terminal.title,
        terminalConfig: terminal,
      });
    }
  }

  const handleCloseTile = useCallback(
    async (tileId: string) => {
      if (!selectedWorktree) return;

      // If it's a terminal, clean up the session and update configuration
      if (tileId.includes("terminal-") || tileId.includes("claude-")) {
        window.electronAPI.closeTerminal?.(tileId);

        const newConfig = {
          ...terminalConfig,
          terminals: terminalConfig.terminals.filter((t) => t.id !== tileId),
        };

        setTerminalConfig(newConfig);
        globalTerminalState.set(selectedWorktree.path, newConfig);

        // Save to persistent storage
        await window.electronAPI.saveWorktreeTerminals(
          selectedWorktree.path,
          newConfig
        );
      }
    },
    [selectedWorktree, terminalConfig]
  );

  const handleSplitTile = useCallback(
    async (_tileId: string, _direction: "horizontal" | "vertical") => {
      if (!selectedWorktree) return;

      const newTerminalId = `${selectedWorktree.path}-terminal-${terminalConfig.nextTerminalId}`;
      const newTerminal: TerminalConfig = {
        id: newTerminalId,
        title: `Terminal ${terminalConfig.nextTerminalId}`,
        type: "terminal",
      };

      const newConfig = {
        terminals: [...terminalConfig.terminals, newTerminal],
        nextTerminalId: terminalConfig.nextTerminalId + 1,
      };

      setTerminalConfig(newConfig);
      globalTerminalState.set(selectedWorktree.path, newConfig);

      // Save to persistent storage
      await window.electronAPI.saveWorktreeTerminals(
        selectedWorktree.path,
        newConfig
      );
    },
    [selectedWorktree, terminalConfig]
  );

  const handleAddClaudeTerminal = useCallback(async () => {
    if (!selectedWorktree) return;

    const claudeTerminalId = `${selectedWorktree.path}-claude-${terminalConfig.nextTerminalId}`;
    const claudeTerminal: TerminalConfig = {
      id: claudeTerminalId,
      title: "Claude Terminal",
      type: "claude",
      initialCommand: "claude",
    };

    const newConfig = {
      terminals: [...terminalConfig.terminals, claudeTerminal],
      nextTerminalId: terminalConfig.nextTerminalId + 1,
    };

    setTerminalConfig(newConfig);
    globalTerminalState.set(selectedWorktree.path, newConfig);

    // Save to persistent storage
    await window.electronAPI.saveWorktreeTerminals(
      selectedWorktree.path,
      newConfig
    );
  }, [selectedWorktree, terminalConfig]);

  return {
    terminalTileData,
    selectedWorktree,
    isLoadingTerminals,
    handleCloseTile,
    handleSplitTile,
    handleAddClaudeTerminal,
    updateTileTitle,
  };
};
