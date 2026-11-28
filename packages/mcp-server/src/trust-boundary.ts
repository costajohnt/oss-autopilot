/**
 * What an agent may do through the MCP tools without the user (#1934, #1936).
 *
 * Tool arguments are written by a model that also reads text from strangers
 * (issue bodies, PR comments), so a tool description that says "ask the user
 * first" is a request, not a control. The two rules here are enforced in the
 * server instead:
 *
 *   1. Settings above the `preference` trust tier (a command a later workflow
 *      runs, a path read as the user's own file, the AI-policy ban list)
 *      cannot be written through MCP. A person types them into the CLI.
 *   2. A tool that writes to GitHub under the user's identity asks the user
 *      through the host (MCP elicitation) before it runs.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createRequestStateCodec, inputRequired, inputResponse } from '@modelcontextprotocol/server';
import type { ClientCapabilities, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server';
import { CONFIG_KEY_REGISTRY, assertAttended, errorMessage, getKeyTrust } from '@oss-autopilot/core';
import type { ConfigTrust } from '@oss-autopilot/core';

// ── 1. Settings an agent may not write (#1934, #2035, #2036) ──────────

/**
 * Why each trust tier above `preference` is refused (see `ConfigTrust` in
 * core's config-registry, where every key is classified).
 */
const REFUSAL_REASON: Readonly<Record<Exclude<ConfigTrust, 'preference'>, string>> = {
  command: 'its value decides which command a later review runs',
  path: 'the tool treats the files it names as ones the user chose, without checking whose checkout they are in',
  safeguard: 'it is the AI-policy ban list, and removing an entry lifts a ban',
};

/** The config keys the MCP `config` tool accepts: every given key whose trust tier is `preference`. */
export function mcpSettableKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => getKeyTrust(key) === 'preference');
}

/**
 * Throw when `key=value` is a setting only the CLI may write: any write whose
 * trust tier is not `preference`.
 *
 * A `command` value written by an injected tool call turns a config write into
 * command execution on every machine that shares the synced state. A `path`
 * written that way makes a file from a cloned repository the user's own issue
 * list. A `safeguard` write can empty the AI-policy ban list.
 */
export function assertMcpSettable(key: string, value: string | undefined): void {
  const trust = getKeyTrust(key, value);
  if (trust === 'preference') return;
  const isValueOnly = getKeyTrust(key) === 'preference';
  const setting = isValueOnly ? `${key}=${value}` : key;
  const placeholder = trust === 'command' ? '"<command>"' : '<value>';
  const example = isValueOnly ? setting : `${key}=${placeholder}`;
  throw new Error(
    `${setting} cannot be set through the MCP server: ${REFUSAL_REASON[trust]}. ` +
      `The user sets it in a terminal: oss-autopilot setup --set ${example}`,
  );
}

/** The settings {@link assertMcpSettable} refuses, as `key` or `key=value`, for tool descriptions. */
export function mcpRefusedSettings(): string[] {
  const refused: string[] = [];
  for (const def of CONFIG_KEY_REGISTRY) {
    if (def.settableVia === 'auto') continue;
    if (getKeyTrust(def.key) === 'preference') {
      refused.push(...(def.commandValues ?? []).map((value) => `${def.key}=${value}`));
    } else {
      refused.push(def.key);
    }
  }
  return refused;
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
/** The checkbox label for a GitHub write; actions that write elsewhere pass their own. */
export const SEND_LABEL = 'Send this under my GitHub account';
/** The approval form: one checkbox, labelled with what ticking it allows. */
function approvalSchema(label: string) {
  return z.object({ approve: z.boolean().describe(label) });
}

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

/**
 * How long the user has to answer an approval form, and how long the signed
 * state sent with it stays valid.
 */
export const APPROVAL_TIMEOUT_MS = 120_000;

interface ApprovalState {
  /** {@link approvedArgs} of what the form showed. */
  args: string;
  /** One per form, so an answer can be used once. */
  id: string;
}

/**
 * Signs the `requestState` an approval form travels with (#2015). The key is
 * per process and module-level, so every server instance in the process
 * shares it: the HTTP transport builds a fresh server for each POST, and the
 * follow-up call that carries the answer is a different POST. Pass
 * {@link approvalStateVerify} as `ServerOptions.requestState.verify`.
 */
const approvalState = createRequestStateCodec<ApprovalState>({
  key: randomBytes(32),
  ttlSeconds: APPROVAL_TIMEOUT_MS / 1000,
});
/**
 * A state that fails verification (forged, altered, expired) resolves to
 * null instead of throwing, so the call is not answered with the SDK's
 * protocol error: the SDK hands the tool null as its state, which
 * {@link requireApproval} refuses with the same in-band message as a missing
 * state, and nothing runs.
 */
export async function approvalStateVerify(state: string, ctx: ServerContext): Promise<ApprovalState | null> {
  try {
    return await approvalState.verify(state, ctx);
  } catch {
    return null;
  }
}

/** Ids of approvals already used, with when they stop mattering (their state has expired by then). */
const usedApprovals = new Map<string, number>();

/** Record `id` as used; false when it already was. */
function isFirstUse(id: string): boolean {
  const now = Date.now();
  for (const [used, expiresAt] of usedApprovals) if (expiresAt <= now) usedApprovals.delete(used);
  if (usedApprovals.has(id)) return false;
  usedApprovals.set(id, now + APPROVAL_TIMEOUT_MS);
  return true;
}

/**
 * What an approval is for: the action and the exact arguments, hashed. The
 * arguments are the SDK's zod output, whose keys follow the schema's order,
 * so equal arguments serialize the same way whatever order the host sent.
 */
function approvedArgs(action: string, args: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([action, args]))
    .digest('hex');
}

/**
 * The approval's id when the verified `requestState` was minted for these
 * arguments. The SDK has already run {@link approvalStateVerify}, so a decoded
 * state is one this process minted; null (failed verification), a raw string
 * (no verify hook) or none at all gives undefined.
 */
function approvedId(action: string, args: unknown, ctx: ServerContext): string | undefined {
  const state = ctx.mcpReq.requestState<Partial<ApprovalState> | undefined>();
  return state?.args === approvedArgs(action, args) ? state.id : undefined;
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
 * `approveLabel` is the checkbox text: say what ticking it allows.
 */
export function requireApproval<A, R>(
  hostCapabilities: () => ClientCapabilities | undefined,
  action: string,
  cli: string,
  preview: (args: A) => string,
  handler: (args: A) => Promise<R>,
  approveLabel = SEND_LABEL,
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
          [APPROVAL_KEY]: inputRequired.elicit({ message: shown, requestedSchema: approvalSchema(approveLabel) }),
        },
        requestState: await approvalState.mint({ args: approvedArgs(action, args), id: randomUUID() }),
      });
    }
    if (answer.kind !== 'elicit' || answer.action !== 'accept' || answer.content?.approve !== true) {
      return refusal(`The user did not approve: refusing to ${action}. Do not retry unless the user asks for it.`);
    }
    // The approval covers the arguments the form showed, not whatever arrives with the answer (#2015).
    const id = approvedId(action, args, ctx);
    if (id === undefined) {
      return refusal(
        `Refusing to ${action}: the approval does not match these arguments (they changed after the user saw them, ` +
          'or the approval came without the state the form was sent with). Nothing was sent.',
      );
    }
    // Checked and recorded synchronously before the handler, so a re-sent answer cannot run twice.
    if (!isFirstUse(id)) return refusal(`Refusing to ${action}: this approval was already used. Nothing was sent.`);
    return handler(args);
  };
}
