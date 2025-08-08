import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { TerminalManager, TerminalConfig, WorktreeTerminals } from './terminal-manager';
import * as gitOps from './git-operations';
import * as externalActions from './external-actions';
import { AppData } from './types';

// Context type for tRPC procedures
export interface Context {
  terminalManager: TerminalManager;
  loadAppData: () => Promise<AppData>;
  saveAppData: (data: AppData) => Promise<void>;
  getMainWindow: () => any;
}

// Initialize tRPC with context - no transformer for simplicity
const t = initTRPC.context<Context>().create();

// Export procedure helpers
export const publicProcedure = t.procedure;

// Zod schemas for terminal management
const TerminalConfigSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.enum(['terminal', 'claude']),
  initialCommand: z.string().optional(),
});

const WorktreeTerminalsSchema = z.object({
  terminals: z.array(TerminalConfigSchema),
  nextTerminalId: z.number(),
});

// Zod schemas for git operations
const WorktreeInfoSchema = z.object({
  path: z.string().optional(),
  commit: z.string().optional(),
  branch: z.string().optional(),
  bare: z.boolean().optional(),
});

const BranchStatusSchema = z.object({
  behind: z.number(),
  ahead: z.number(),
  current: z.string().nullable(),
  tracking: z.string().nullable(),
});

const CommitSchema = z.object({
  hash: z.string(),
  message: z.string(),
  author_name: z.string(),
  author_email: z.string(),
  date: z.string(),
});

const MergeOptionsSchema = z.object({
  noFF: z.boolean().optional(),
  squash: z.boolean().optional(),
  message: z.string().optional(),
});

// Repository schemas
const RepositorySchema = z.object({
  path: z.string(),
  name: z.string(),
  addedAt: z.string(),
});

const RepositoryConfigSchema = z.object({
  mainBranch: z.string().nullable(),
  initCommand: z.string().nullable(),
  worktreeDirectory: z.string().nullable(),
});

// Create comprehensive tRPC router with git operations
export const router = t.router({
  hello: publicProcedure
    .input(z.object({ name: z.string().optional() }))
    .query(({ input }) => {
      console.log("=== tRPC hello query received ===", input);
      const name = input.name || "World";
      const result = `Hello ${name}!`;
      console.log("=== tRPC hello query result ===", result);
      return result;
    }),

  // Terminal management procedures
  getWorktreeTerminals: publicProcedure
    .input(z.object({ worktreePath: z.string() }))
    .query(({ input, ctx }) => {
      const terminals = ctx.terminalManager.getWorktreeTerminals(input.worktreePath);
      return {
        terminals: terminals.terminals || [],
        nextTerminalId: terminals.nextTerminalId || 1
      };
    }),

  addTerminalToWorktree: publicProcedure
    .input(z.object({
      worktreePath: z.string(),
      terminal: TerminalConfigSchema,
    }))
    .mutation(({ input, ctx }) => {
      ctx.terminalManager.addTerminalToWorktree(input.worktreePath, input.terminal);
      const terminals = ctx.terminalManager.getWorktreeTerminals(input.worktreePath);
      return {
        terminals: terminals.terminals || [],
        nextTerminalId: terminals.nextTerminalId || 1
      };
    }),

  removeTerminalFromWorktree: publicProcedure
    .input(z.object({
      worktreePath: z.string(),
      terminalId: z.string(),
    }))
    .mutation(({ input, ctx }) => {
      ctx.terminalManager.removeTerminalFromWorktree(input.worktreePath, input.terminalId);
      const terminals = ctx.terminalManager.getWorktreeTerminals(input.worktreePath);
      return {
        terminals: terminals.terminals || [],
        nextTerminalId: terminals.nextTerminalId || 1
      };
    }),

  // Git operations
  getWorktrees: publicProcedure
    .input(z.object({ repoPath: z.string() }))
    .query(async ({ input }) => {
      return await gitOps.getWorktrees(input.repoPath);
    }),

  getBranches: publicProcedure
    .input(z.object({ repoPath: z.string() }))
    .query(async ({ input }) => {
      return await gitOps.getBranches(input.repoPath);
    }),

  getGitUsername: publicProcedure
    .input(z.object({ repoPath: z.string() }))
    .query(async ({ input }) => {
      return await gitOps.getGitUsername(input.repoPath);
    }),

  // Worktree management
  createWorktree: publicProcedure
    .input(z.object({
      repoPath: z.string(),
      branchName: z.string(),
      baseBranch: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      const configData = await ctx.loadAppData();
      const repoConfiguration = configData.repositoryConfigs[input.repoPath];
      return await gitOps.createWorktree(
        input.repoPath,
        input.branchName,
        input.baseBranch,
        repoConfiguration,
        ctx.terminalManager
      );
    }),

  archiveWorktree: publicProcedure
    .input(z.object({
      repoPath: z.string(),
      worktreePath: z.string(),
      force: z.boolean().optional().default(false),
    }))
    .mutation(async ({ input, ctx }) => {
      const appData = await ctx.loadAppData();
      const repoConfig = appData.repositoryConfigs[input.repoPath] || {
        mainBranch: null,
        initCommand: null,
        worktreeDirectory: null,
      };
      return await gitOps.archiveWorktree(
        input.repoPath,
        input.worktreePath,
        input.force,
        repoConfig
      );
    }),

  // Branch operations
  checkBranchMerged: publicProcedure
    .input(z.object({
      repoPath: z.string(),
      branchName: z.string(),
    }))
    .query(async ({ input, ctx }) => {
      const appData = await ctx.loadAppData();
      const repoConfig = appData.repositoryConfigs[input.repoPath] || {
        mainBranch: null,
        initCommand: null,
        worktreeDirectory: null,
      };
      return await gitOps.checkBranchMerged(
        input.repoPath,
        input.branchName,
        repoConfig
      );
    }),

  mergeWorktree: publicProcedure
    .input(z.object({
      repoPath: z.string(),
      fromBranch: z.string(),
      toBranch: z.string(),
      options: MergeOptionsSchema,
    }))
    .mutation(async ({ input }) => {
      return await gitOps.mergeWorktree(
        input.repoPath,
        input.fromBranch,
        input.toBranch,
        input.options
      );
    }),

  rebaseWorktree: publicProcedure
    .input(z.object({
      worktreePath: z.string(),
      fromBranch: z.string(),
      ontoBranch: z.string(),
    }))
    .mutation(async ({ input }) => {
      return await gitOps.rebaseWorktree(
        input.worktreePath,
        input.fromBranch,
        input.ontoBranch
      );
    }),

  // Status and logging
  getWorktreeStatus: publicProcedure
    .input(z.object({ worktreePath: z.string() }))
    .query(async ({ input }) => {
      return await gitOps.getWorktreeStatus(input.worktreePath);
    }),

  getCommitLog: publicProcedure
    .input(z.object({
      worktreePath: z.string(),
      baseBranch: z.string(),
    }))
    .query(async ({ input }) => {
      return await gitOps.getCommitLog(input.worktreePath, input.baseBranch);
    }),

  // Repository management operations
  getSavedRepos: publicProcedure
    .query(async ({ ctx }) => {
      try {
        const appData = await ctx.loadAppData();
        return appData.repositories;
      } catch (error) {
        console.error("Failed to get saved repos:", error);
        return [];
      }
    }),

  saveRepo: publicProcedure
    .input(z.object({ repoPath: z.string() }))
    .mutation(async ({ input, ctx }) => {
      try {
        const appData = await ctx.loadAppData();

        // Check if repo already exists
        const exists = appData.repositories.some(
          (repo: any) => repo.path === input.repoPath
        );
        if (!exists) {
          // Get repo name from path
          const path = require('path');
          const repoName = path.basename(input.repoPath);
          appData.repositories.push({
            path: input.repoPath,
            name: repoName,
            addedAt: new Date().toISOString(),
          });
          await ctx.saveAppData(appData);
        }

        return true;
      } catch (error) {
        console.error("Failed to save repo:", error);
        throw new Error(`Failed to save repository: ${error}`);
      }
    }),

  getSelectedRepo: publicProcedure
    .query(async ({ ctx }) => {
      try {
        const appData = await ctx.loadAppData();
        return appData.selectedRepo;
      } catch (error) {
        console.error("Failed to get selected repo:", error);
        return null;
      }
    }),

  setSelectedRepo: publicProcedure
    .input(z.object({ repoPath: z.string().nullable() }))
    .mutation(async ({ input, ctx }) => {
      try {
        const appData = await ctx.loadAppData();
        appData.selectedRepo = input.repoPath;
        await ctx.saveAppData(appData);
        return true;
      } catch (error) {
        console.error("Failed to set selected repo:", error);
        throw new Error(`Failed to save selected repository: ${error}`);
      }
    }),

  getRepoConfig: publicProcedure
    .input(z.object({ repoPath: z.string() }))
    .query(async ({ input, ctx }) => {
      try {
        const appData = await ctx.loadAppData();
        return appData.repositoryConfigs[input.repoPath] || {
          mainBranch: null,
          initCommand: null,
          worktreeDirectory: null,
        };
      } catch (error) {
        console.error("Failed to get repo config:", error);
        return { mainBranch: null, initCommand: null, worktreeDirectory: null };
      }
    }),

  saveRepoConfig: publicProcedure
    .input(z.object({
      repoPath: z.string(),
      config: RepositoryConfigSchema,
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        const appData = await ctx.loadAppData();
        appData.repositoryConfigs[input.repoPath] = input.config;
        await ctx.saveAppData(appData);
        return true;
      } catch (error) {
        console.error("Failed to save repo config:", error);
        throw new Error(`Failed to save repository config: ${error}`);
      }
    }),

  getRecentWorktree: publicProcedure
    .input(z.object({ repoPath: z.string() }))
    .query(async ({ input, ctx }) => {
      try {
        const appData = await ctx.loadAppData();
        return appData.recentWorktrees[input.repoPath] || null;
      } catch (error) {
        console.error("Failed to get recent worktree:", error);
        return null;
      }
    }),

  setRecentWorktree: publicProcedure
    .input(z.object({
      repoPath: z.string(),
      worktreePath: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        const appData = await ctx.loadAppData();
        appData.recentWorktrees[input.repoPath] = input.worktreePath;
        await ctx.saveAppData(appData);
        return true;
      } catch (error) {
        console.error("Failed to set recent worktree:", error);
        return false;
      }
    }),

  selectFolder: publicProcedure
    .mutation(async ({ ctx }) => {
      const { dialog } = require('electron');
      const mainWindow = ctx.getMainWindow();
      if (!mainWindow) {
        throw new Error("Main window not available");
      }

      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openDirectory"],
        title: "Select Git Repository Folder",
      });

      if (result.canceled) {
        return null;
      }

      return result.filePaths[0];
    }),

  // External action operations
  openInFileManager: publicProcedure
    .input(z.object({ folderPath: z.string() }))
    .mutation(async ({ input }) => {
      return await externalActions.openInFileManager(input.folderPath);
    }),

  openInEditor: publicProcedure
    .input(z.object({ folderPath: z.string() }))
    .mutation(async ({ input }) => {
      return await externalActions.openInEditor(input.folderPath);
    }),

  openInTerminal: publicProcedure
    .input(z.object({ folderPath: z.string() }))
    .mutation(async ({ input }) => {
      return await externalActions.openInTerminal(input.folderPath);
    }),

  openDirectory: publicProcedure
    .input(z.object({ dirPath: z.string() }))
    .mutation(async ({ input }) => {
      return await externalActions.openDirectory(input.dirPath);
    }),

  openTerminalInDirectory: publicProcedure
    .input(z.object({ dirPath: z.string() }))
    .mutation(async ({ input }) => {
      return await externalActions.openTerminalInDirectory(input.dirPath);
    }),

  openVSCode: publicProcedure
    .input(z.object({ dirPath: z.string() }))
    .mutation(async ({ input }) => {
      return await externalActions.openVSCode(input.dirPath);
    }),
});

// Export the router type for client-side usage
export type AppRouter = typeof router;