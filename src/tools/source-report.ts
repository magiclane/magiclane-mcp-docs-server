/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * How tools talk about documentation sources that could not be loaded. The
 * server instructions tell the model to say "Magic Lane does not document
 * this" when a search finds nothing, so a network failure must never look
 * like an empty result: every response names the sources it could not read,
 * and a response is an error when none of the requested sources loaded.
 */
import type { SourceFailure } from '../docs/source-memo.js';

const FILE_NAMES: Record<SourceFailure['part'], string> = {
  index: 'index (llms.txt)',
  'full-text': 'page contents (llms-full.txt)',
};

/** One line per failed file, naming the source and which of its two files failed. */
function failureLines(failed: SourceFailure[]): string {
  return failed.map((f) => `- ${f.source} ${FILE_NAMES[f.part]}: ${f.reason}`).join('\n');
}

/**
 * Why the files failed, in one phrase: developer.magiclane.com could not be
 * reached, or it answered without a usable file (not found, an HTML page, an
 * empty or changed file). Either way it is never a gap in the documentation.
 */
function diagnosis(failed: SourceFailure[]): string {
  const unreachable = failed.filter((f) => f.kind === 'unreachable').length;
  if (unreachable === failed.length) return 'a problem reaching developer.magiclane.com';
  if (unreachable === 0) {
    return 'a problem with the file(s) published on developer.magiclane.com (not found, empty, or not in the llms.txt format)';
  }
  return 'a problem reaching developer.magiclane.com, and with file(s) published there';
}

/** A trailing note listing the source files that failed, or '' when none did. */
export function sourceFailureNote(failed: SourceFailure[]): string {
  if (failed.length === 0) return '';
  return (
    `\n\n## Sources not loaded\n\n` +
    `${failed.length} documentation file(s) could not be loaded, so results from them are missing — ` +
    `${diagnosis(failed)}, not a gap in the documentation:\n${failureLines(failed)}`
  );
}

/** The error text for a call where every requested source failed to load. */
export function allSourcesFailedMessage(what: string, failed: SourceFailure[], verb = 'searched'): string {
  // Only an unreachable host is worth retrying; a missing or broken file is not.
  const retry = failed.some((f) => f.kind === 'unreachable');
  return (
    `Could not load the ${what} for any of the requested documentation source(s), so nothing was ${verb}. ` +
    `This is ${diagnosis(failed)}, not a documentation gap${retry ? ' — retry shortly' : ''}.\n` +
    failureLines(failed)
  );
}
