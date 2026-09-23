import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CodexSession, codexLaunchArgs } from './codex-session.ts';
import type { WireMessagesRequest } from './wire.ts';

const request = {
  model: 'gpt-5.6-sol',
  system: 'Operate the Pix3 editor.',
  messages: [{ role: 'user', content: 'Create a node' }],
  tools: [{ name: 'create_node', description: 'Create a node', input_schema: { type: 'object' } }],
} as WireMessagesRequest;

describe('CodexSession editor tools', () => {
  it('always exposes the editor tool catalog', () => {
    const session = new CodexSession(request, () => {}, {
      binary: 'codex',
      mcpUrl: 'http://127.0.0.1:1/agents/codex/mcp',
      mcpToken: 'mcp-token',
    });
    assert.deepEqual(
      session.listTools().tools.map(tool => tool.name),
      ['create_node']
    );
    assert.equal(session.toolsMatch(request.tools), true);
  });

  it('always configures the Pix3 MCP relay and unattended approval mode', () => {
    const args = codexLaunchArgs({
      conversationId: null,
      model: request.model,
      toolNames: ['create_node'],
    });
    assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(args.some(arg => arg.startsWith('mcp_servers.pix3.command=')));
    assert.ok(args.includes('mcp_servers.pix3.required=true'));
    assert.ok(args.includes('mcp_servers.pix3.tools."create_node".approval_mode="auto"'));
    assert.ok(args.includes('features.shell_tool=false'));
    assert.ok(args.includes('tools.view_image=false'));
    assert.ok(args.includes('tools.web_search=false'));
  });
});
