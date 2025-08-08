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

// Create a minimal tRPC router for testing
export const router = t.router({
  hello: publicProcedure
    .input(z.object({ name: z.string().optional() }))
    .query(() => {
      // Ultra minimal response
      return "Hello World";
    }),

  /*
  // Terminal management procedures
  getWorktreeTerminals: publicProcedure
    .input(z.object({ worktreePath: z.string() }))
    .query(({ input, ctx }) => {
      const terminals = ctx.terminalManager.getWorktreeTerminals(input.worktreePath);
      // Ensure we return a plain object that can be serialized
      return {
        terminals: terminals.terminals,
        nextTerminalId: terminals.nextTerminalId
      };
    }),

  watchWorktreeTerminals: publicProcedure
    .input(z.object({ worktreePath: z.string() }))
    .subscription(async function* ({ input, ctx }) {
      // For now, just yield current state once (we'll implement full subscription later)
      const terminals = ctx.terminalManager.getWorktreeTerminals(input.worktreePath);
      yield {
        terminals: terminals.terminals,
        nextTerminalId: terminals.nextTerminalId
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
        terminals: terminals.terminals,
        nextTerminalId: terminals.nextTerminalId
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
        terminals: terminals.terminals,
        nextTerminalId: terminals.nextTerminalId
      };
    }),

  createSetupTerminal: publicProcedure
    .input(z.object({
      worktreePath: z.string(),
      initCommand: z.string(),
    }))
    .mutation(({ input, ctx }) => {
      ctx.terminalManager.createSetupTerminal(input.worktreePath, input.initCommand);
      const terminals = ctx.terminalManager.getWorktreeTerminals(input.worktreePath);
      return {
        terminals: terminals.terminals,
        nextTerminalId: terminals.nextTerminalId
      };
    }),
  */
});

// Export the router type for client-side usage
export type AppRouter = typeof router;