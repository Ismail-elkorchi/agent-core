/** Small authored memory tasks. Expected values are used only by the scorer. */
export function contextWorkloads(delay = 6) {
  const make = (id, initial, corrected, replacement) => {
    const turns = [];
    const add = (task, expected) => turns.push({ task, ...(expected ? { expected: { ...expected } } : {}) });
    let sequence = 0;
    const update = (changes, explanation) => `${explanation}\nSTATE[${String(sequence++).padStart(3, '0')}] ${JSON.stringify(changes)}`;
    const state = { ...initial };
    add(`${'Background detail that does not change the requirements. '.repeat(22)}\n${update(state, 'These settings continue until I explicitly change them. Acknowledge receipt.')}`);
    for (let i = 0; i < delay; i += 1) add(`Side question ${i + 1}: acknowledge this unrelated progress check. Keep the existing objective and requirements.`);
    Object.assign(state, corrected);
    add(update(corrected, 'Correction: these values replace the earlier values of the same fields; all other settings continue.'));
    for (let i = 0; i < delay; i += 1) add(`Unrelated observation ${i + 1}: the weather is clear. This does not replace the task.`);
    add('REPORT: Return only a JSON object containing the current objective, code, format, and access. Recover earlier requirements if needed.', state);
    Object.assign(state, replacement);
    add(update(replacement, 'Explicit task replacement: retire the old objective and code. The format and access requirements still apply.'));
    for (let i = 0; i < delay; i += 1) add(`Progress check ${i + 1}: acknowledge; continue the replacement task.`);
    add('REPORT: Return only a JSON object containing the current objective, code, format, and access. Do not use superseded values.', state);
    return { id, turns, continuingKeys: ['format', 'access'], correctedKeys: ['code'], retired: { objective: [initial.objective], code: [initial.code, corrected.code] } };
  };
  return [
    make('delayed-delivery', { objective: 'harbor-delivery', code: 'WREN', format: 'json', access: 'read-only' }, { code: 'MINT' }, { objective: 'forest-survey', code: 'HERON' }),
    make('delayed-inventory', { objective: 'archive-inventory', code: 'LARCH', format: 'json', access: 'read-only' }, { code: 'CEDAR' }, { objective: 'museum-catalogue', code: 'BIRCH' })
  ];
}

export function scoreAnswer(text, turn, workload) {
  let answer;
  try { answer = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/gu, '')); } catch { answer = null; }
  const equal = (key) => answer !== null && typeof answer === 'object' && answer[key] === turn.expected[key];
  return {
    success: Object.keys(turn.expected).every(equal),
    continuingConstraintAdherence: workload.continuingKeys.every(equal),
    latestCorrectionUsed: workload.correctedKeys.every(equal),
    staleFactErrors: Object.entries(workload.retired).filter(([key, values]) => values.includes(answer?.[key]) && answer[key] !== turn.expected[key]).length,
    validJson: answer !== null && typeof answer === 'object' && !Array.isArray(answer)
  };
}
