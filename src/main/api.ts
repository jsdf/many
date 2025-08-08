import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { TerminalManager, TerminalConfig, WorktreeTerminals } from './terminal-manager';

// Context type for tRPC procedures
export interface Context {
  terminalManager: TerminalManager;
}

// Initialize tRPC with context
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

// Create the main tRPC router
export const router = t.router({
  hello: publicProcedure
    .input(z.object({ name: z.string().optional() }))
    .query(({ input }) => {
      return {
        greeting: `Hello ${input.name ?? 'World'}!`,
        timestamp: new Date().toISOString(),
      };
    }),

  // Terminal management procedures
  getWorktreeTerminals: publicProcedure
    .input(z.object({ worktreePath: z.string() }))
    .query(({ input, ctx }) => {
      return ctx.terminalManager.getWorktreeTerminals(input.worktreePath);
    }),

  watchWorktreeTerminals: publicProcedure
    .input(z.object({ worktreePath: z.string() }))
    .subscription(async function* ({ input, ctx }) {
      // For now, just yield current state once (we'll implement full subscription later)
      const terminals = ctx.terminalManager.getWorktreeTerminals(input.worktreePath);
      yield terminals;
    }),

  addTerminalToWorktree: publicProcedure
    .input(z.object({
      worktreePath: z.string(),
      terminal: TerminalConfigSchema,
    }))
    .mutation(({ input, ctx }) => {
      ctx.terminalManager.addTerminalToWorktree(input.worktreePath, input.terminal);
      return ctx.terminalManager.getWorktreeTerminals(input.worktreePath);
    }),

  removeTerminalFromWorktree: publicProcedure
    .input(z.object({
      worktreePath: z.string(),
      terminalId: z.string(),
    }))
    .mutation(({ input, ctx }) => {
      ctx.terminalManager.removeTerminalFromWorktree(input.worktreePath, input.terminalId);
      return ctx.terminalManager.getWorktreeTerminals(input.worktreePath);
    }),

  createSetupTerminal: publicProcedure
    .input(z.object({
      worktreePath: z.string(),
      initCommand: z.string(),
    }))
    .mutation(({ input, ctx }) => {
      ctx.terminalManager.createSetupTerminal(input.worktreePath, input.initCommand);
      return ctx.terminalManager.getWorktreeTerminals(input.worktreePath);
    }),
});

// Export the router type for client-side usage
export type AppRouter = typeof router;