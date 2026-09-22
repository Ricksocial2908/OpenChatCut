import { useRef } from 'react';
import type { AgentContext } from '../../agent/context';
import type { AgentController } from '../../agent/useAgent';
import { useAgentState, type AgentHookState } from '../../agent/useAgentState';
import { enhanceAgentPrompt } from '../../agent/agent-session';
import { useServerRun } from '../../agent/useServerRun';
import type { ServerRunController } from '../../agent/serverRunProtocol';
import {
  useServerRunProposalBridge,
  type ServerRunProposalBridge,
} from '../../agent/serverRunProposalBridge';

/**
 * Adapt the server-side run controller + its proposal bridge into the chat
 * panel's AgentController surface. Server-side execution is now the only Agent
 * run path (the browser-side runAgent loop was removed); this adapter covers
 * every controller field without a fallback to browser execution.
 */
function recordLocalTurn(state: AgentHookState, userText: string, reply: string, ok = true): void {
  const text = userText.trim();
  const answer = reply.trim();
  if (!text || !answer) return;
  state.setMessages((current) => [
    ...current,
    { role: 'user', text, local: true },
    ok ? { role: 'assistant', text: answer } : { role: 'error', text: answer },
  ]);
}

function serverRunAdapter(
  run: ServerRunController,
  bridge: ServerRunProposalBridge,
  state: AgentHookState,
): AgentController {
  return {
    messages: run.messages,
    running: run.running,
    hydrated: bridge.session.hydrated,
    contextUsage: run.contextUsage,
    proposal: bridge.proposal,
    proposalStale: bridge.proposalStale,
    liveTool: run.liveTool,
    changeLog: bridge.changeLog,
    send: run.send,
    stop: run.stop,
    // Prompt enhancement is a single, stateless model call (a short text
    // rewrite), not the Agent run loop; it stays a direct model invocation.
    enhance: enhanceAgentPrompt,
    clearHistory: bridge.clearHistory,
    applyProposal: bridge.applyProposal,
    forceApplyProposal: bridge.forceApplyProposal,
    rejectProposal: bridge.rejectProposal,
    reProposeStale: bridge.reProposeStale,
    rollbackChangeSession: bridge.rollbackChangeSession,
    canRollbackChangeSession: bridge.canRollbackChangeSession,
    rewindTurn: bridge.rewindTurn,
    recordLocalTurn: (userText, reply, ok) => recordLocalTurn(state, userText, reply, ok),
  };
}

/**
 * Chat-panel Agent controller. `serverRunEnabled` is accepted for signature
 * compatibility but is deliberately ignored: server-side execution is the only
 * Agent path, so the panel always drives useServerRun and never a browser-side
 * runAgent loop.
 */
export function useChatAgentController(
  ctx: AgentContext,
  projectId: string,
  _serverRunEnabled = true,
): AgentController {
  const state = useAgentState(ctx);
  const serverRunRef = useRef<AgentController['send']>(() => Promise.resolve());
  const bridge = useServerRunProposalBridge(
    state,
    ctx,
    projectId,
    true,
    (text, options) => { void serverRunRef.current(text, options); },
  );
  const run = useServerRun(ctx, projectId, {
    enabled: true,
    session: bridge.session,
    onRunPrepare: bridge.onRunPrepare,
    onRunAbandon: bridge.onRunAbandon,
    onRunStart: bridge.onRunStart,
    onToolAction: bridge.onToolAction,
    onTerminal: bridge.onTerminal,
  });
  serverRunRef.current = run.send;
  return serverRunAdapter(run, bridge, state);
}
