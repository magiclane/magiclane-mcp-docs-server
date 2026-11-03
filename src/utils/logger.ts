/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Verbose logging, gated by the VERBOSE environment variable (default false).
 *
 * IMPORTANT: on the stdio transport, stdout carries the MCP protocol — every
 * diagnostic must go to stderr, which is what console.error does.
 */
import { VERBOSE } from '../config/env.js';

/** True when verbose logging is enabled for this process. */
export function isVerbose(): boolean {
  return VERBOSE;
}

/** Log a diagnostic line to stderr, only when VERBOSE is enabled. */
export function logVerbose(message: string): void {
  if (!VERBOSE) return;
  console.error(`[Magic Lane MCP Docs] ${message}`);
}

/** Log an MCP tool invocation (name only) to stderr, only when VERBOSE. */
export function logToolInvocation(toolName: string): void {
  logVerbose(`tool invoked: ${toolName}`);
}
