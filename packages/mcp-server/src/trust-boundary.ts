/**
 * What an agent may do through the MCP tools without the user (#1934, #1936).
 *
 * Tool arguments are written by a model that also reads text from strangers
 * (issue bodies, PR comments), so a tool description that says "ask the user
 * first" is a request, not a control. The two rules here are enforced in the
 * server instead:
 *
 *   1. Settings whose stored value a later workflow runs as a command cannot
 *      be written through MCP. A person types them into the CLI.
 *   2. A tool that writes to GitHub under the user's identity asks the user
 *      through the host (MCP elicitation) before it runs.
 */
import { z } from 'zod';
import { inputRequired, inputResponse } from '@modelcontextprotocol/server';
import type { ClientCapabilities, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server';
import { assertAttended, errorMessage } from '@oss-autopilot/core';

// ── 1. Settings an agent may not write (#1934) ────────────────────────

/** Keys refused over MCP whatever the value. */
const CLI_ONLY_KEYS: ReadonlySet<string> = new Set(['diffToolCustomCommand']);
/** Values refused over MCP for an otherwise settable key. */
const CLI_ONLY_VALUES: ReadonlyMap<string, readonly string[]> = new Map([['diffTool', ['custom']]]);

/** The config keys the MCP `config` tool accepts: every known key except the CLI-only ones. */
export function mcpSettableKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => !CLI_ONLY_KEYS.has(key));
}

/**
 * Throw when `key=value` is a setting only the CLI may write.
 *
 * `diffToolCustomCommand` is a command line the pre-commit review runs, and
 * `diffTool=custom` is the switch that makes it run. Either one written by an
 * injected tool call turns a config write into command execution on every
 * machine that shares the synced state.
 */
export function assertMcpSettable(key: string, value: string | undefined): void {
  const isCliOnlyKey = CLI_ONLY_KEYS.has(key);
  const isCliOnlyValue = value !== undefined && (CLI_ONLY_VALUES.get(key) ?? []).includes(value);
  if (!isCliOnlyKey && !isCliOnlyValue) return;
  const setting = isCliOnlyKey ? key : `${key}=${value}`;
  const example = isCliOnlyKey ? `${key}="<command>"` : setting;
  throw new Error(
    `${setting} cannot be set through the MCP server: its value decides which command a later review runs. ` +
      `The user sets it in a terminal: oss-autopilot setup --set ${example}`,
  );
}

/** {@link assertMcpSettable} for the `key=value` pairs of the `setup` tool, split the way `runSetup` splits them. */
export function assertMcpSettablePairs(pairs: readonly string[] = []): void {
  for (const pair of pairs) {
    const [key, ...valueParts] = pair.split('=');
    assertMcpSettable(key, valueParts.join('='));
  }
}

// ── 2. User approval for GitHub writes (#1936) ────────────────────────

const APPROVAL_KEY = 'approval';
/** Opt-in for hosts that cannot show a form: their own permission prompt becomes the only approval. */
export const ALLOW_UNCONFIRMED_ENV = 'OSS_AUTOPILOT_MCP_ALLOW_UNCONFIRMED_WRITES';
const approvalSchema = z.object({
  approve: z.boolean().describe('Send this under my GitHub account'),
});

/**
 * Characters a form cannot show faithfully: every format character (\p{Cf}:
 * bidi controls, zero-width characters, word joiner, soft hyphen, tag
 * characters), default-ignorable code points (variation selectors, combining
 * grapheme joiner, Hangul fillers), line and paragraph separators,
 * private-use and unassigned code points, lone surrogates (\p{Cs}: the
 * target is ES2022, where String#isWellFormed is not typed), and C0/C1
 * controls other than tab, newline and a carriage return that starts a CRLF
 * (a bare CR can overwrite a line on screen). Stripping them would post text
 * other than what the user approved, so a preview containing one is refused
 * instead.
 * Ceiling: \p{Cf} includes U+200D, so emoji ZWJ sequences are refused too.
 */
const HIDDEN_CHARACTERS =
  /(?![\t\n]|\r\n)[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/u;
/** The one variation selector allowed: a single U+FE0E or U+FE0F right after a pictograph (as in ❤️). */
const EMOJI_PRESENTATION = /(\p{Extended_Pictographic})[\u{FE0E}\u{FE0F}]/gu;

/** The first character {@link HIDDEN_CHARACTERS} refuses, checked on a copy without the allowed emoji selectors. */
function firstHiddenCharacter(text: string): string | undefined {
  return HIDDEN_CHARACTERS.exec(text.replaceAll(EMOJI_PRESENTATION, '$1'))?.[0];
}

/** "N characters", counted in code points. */
function characterCount(text: string): string {
  const count = [...text].length;
  return `${count} character${count === 1 ? '' : 's'}`;
}

/**
 * Text for an approval form, between start and end markers so the user sees
 * exactly where it begins and ends: `--- comment start (N characters) ---`,
 * the text, `--- comment end ---`. Every line of the text is shown after
 * "│ ", so text that contains its own end marker cannot fake the frame. Only
 * the form is prefixed; the text posted is the original.
 */
export function framed(label: string, text: string): string {
  const body = text
    .split('\n')
    .map((line) => `│ ${line}`)
    .join('\n');
  return `--- ${label} start (${characterCount(text)}) ---\n${body}\n--- ${label} end ---`;
}

function refusal(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

/** True when the host said it can show the user a form: `elicitation: {}` (the pre-mode shape) or one with `form`. */
function canShowForm(capabilities: ClientCapabilities | undefined): boolean {
  const elicitation = capabilities?.elicitation;
  return elicitation !== undefined && (elicitation.form !== undefined || elicitation.url === undefined);
}

/**
 * Gate a GitHub-writing tool on the user's approval.
 *
 * The question goes to the user through the host, outside the model's reach:
 * the answer arrives as a protocol-level input response, never as a tool
 * argument, so the model cannot supply it. Anything but an accepted form with
 * the box ticked refuses.
 *
 * A host that cannot show a form (no elicitation capability, URL-only
 * elicitation, or the stateless HTTP transport, where no capabilities are
 * known) is refused, naming the CLI command `cli` that does the same with the
 * user at the keyboard. Setting {@link ALLOW_UNCONFIRMED_ENV}=1 lets such a
 * host run the tool on its own permission prompt instead.
 * An unattended run is refused before anything is asked.
 *
 * `hostCapabilities` returns what the connected host declared, read per call.
 */
export function requireApproval<A, R>(
  hostCapabilities: () => ClientCapabilities | undefined,
  action: string,
  cli: string,
  preview: (args: A) => string,
  handler: (args: A) => Promise<R>,
): (args: A, ctx: ServerContext) => Promise<R | InputRequiredResult | ReturnType<typeof refusal>> {
  return async (args, ctx) => {
    try {
      assertAttended(action);
    } catch (e) {
      return refusal(errorMessage(e));
    }
    const shown = preview(args);
    const hidden = firstHiddenCharacter(shown);
    if (hidden !== undefined) {
      const code = hidden.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
      return refusal(
        `Refusing to ${action}: the text contains invisible formatting characters (first: U+${code}), ` +
          'so the user could not see exactly what would be sent. This includes the joiner inside some emoji. ' +
          'Remove them and try again.',
      );
    }
    if (!canShowForm(hostCapabilities())) {
      if (process.env[ALLOW_UNCONFIRMED_ENV] === '1') return handler(args);
      return refusal(
        `Refusing to ${action}: this MCP host cannot show the user an approval form. ` +
          `The user can run it in a terminal instead: ${cli}. ` +
          `To let this host's own permission prompt be the only approval, start the server with ${ALLOW_UNCONFIRMED_ENV}=1.`,
      );
    }
    const answer = inputResponse(ctx.mcpReq.inputResponses, APPROVAL_KEY);
    if (answer.kind === 'missing') {
      return inputRequired({
        inputRequests: {
          [APPROVAL_KEY]: inputRequired.elicit({ message: shown, requestedSchema: approvalSchema }),
        },
      });
    }
    if (answer.kind !== 'elicit' || answer.action !== 'accept' || answer.content?.approve !== true) {
      return refusal(`The user did not approve: refusing to ${action}. Do not retry unless the user asks for it.`);
    }
    return handler(args);
  };
}
