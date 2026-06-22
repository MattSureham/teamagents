import type { MeetingEngine } from './engine.js';

export function formatLog(engine: MeetingEngine): string {
  const lines: string[] = [];
  lines.push('═'.repeat(60));
  lines.push(`MEETING: ${engine.topic}`);
  lines.push(`ID:      ${engine.id}`);
  lines.push(`STATUS:  ${engine.status}`);
  lines.push(`ENDED:   ${engine.reasonEnded}`);
  lines.push(`STARTED: ${new Date(engine.createdAt).toISOString()}`);
  if (engine.concludedAt) {
    lines.push(`ENDED:   ${new Date(engine.concludedAt).toISOString()}`);
  }
  lines.push(`TURNS:   ${engine.transcript.length}`);
  lines.push('═'.repeat(60));
  lines.push('');

  const phaseLabels: Record<string, string> = {
    opening: '═══ OPENING ═══',
    position: '═══ POSITION STATEMENTS ═══',
    rebuttal: '═══ REBUTTALS ═══',
    deliberation: '═══ DELIBERATION ═══',
    voting: '═══ VOTING ═══',
    plan: '═══ PLANNING ═══',
    build: '═══ BUILD ═══',
    review: '═══ REVIEW ═══',
    wrapup: '═══ WRAP-UP ═══',
    summary: '═══ SUMMARY ═══',
    concluded: '═══ CONCLUDED ═══',
  };

  let lastPhase = '';
  for (const msg of engine.transcript) {
    if (msg.phase !== lastPhase) {
      lastPhase = msg.phase;
      lines.push('');
      lines.push(phaseLabels[msg.phase] ?? `─── ${msg.phase.toUpperCase()} ───`);
      lines.push('');
    }

    const time = new Date(msg.timestamp).toLocaleTimeString();
    const indent = msg.authorId === '__system_moderator__' ? '◆' : '  ◇';
    lines.push(`${indent} [${time}] ${msg.authorName}:`);

    for (const line of msg.content.split('\n')) {
      lines.push(`    ${line}`);
    }
    lines.push('');
  }

  if (engine.summary) {
    lines.push('');
    lines.push('═'.repeat(60));
    lines.push('STRUCTURED SUMMARY');
    lines.push('═'.repeat(60));
    lines.push('');
    lines.push(`Consensus: ${engine.summary.consensus}`);
    lines.push('');
    lines.push('Key Points:');
    for (const p of engine.summary.keyPoints) {
      lines.push(`  • ${p}`);
    }
    if (engine.summary.dissentingViews.length > 0) {
      lines.push('');
      lines.push('Dissenting Views:');
      for (const v of engine.summary.dissentingViews) {
        lines.push(`  • ${v}`);
      }
    }
    if (engine.summary.actionItems.length > 0) {
      lines.push('');
      lines.push('Action Items:');
      for (const a of engine.summary.actionItems) {
        lines.push(`  • ${a}`);
      }
    }
    if (engine.summary.voteTally) {
      lines.push('');
      lines.push(`Vote: YES=${engine.summary.voteTally.yes ?? 0} NO=${engine.summary.voteTally.no ?? 0} ABSTAIN=${engine.summary.voteTally.abstain ?? 0}`);
    }
  }

  return lines.join('\n');
}
