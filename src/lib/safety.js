/**
 * "Information, not instructions": business data ends up in front of AI agents,
 * so text that reads like an instruction to the agent is a prompt-injection risk.
 * These patterns flag the common shapes; a flag means a person should look at it.
 */
const PATTERNS = [
  { re: /\b(ignore|disregard|forget)\b.{0,30}\b(previous|prior|above|earlier|all)\b.{0,20}\b(instructions?|prompts?|rules?)\b/i, why: 'tells the agent to ignore its instructions' },
  { re: /\b(system prompt|developer message|you are (now )?(an?|the) (ai|assistant|agent|model))\b/i, why: 'addresses the agent directly' },
  { re: /\b(install|connect|add|enable)\s+(this|the|our)\s+(connector|server|skill|extension|plugin|tool|app)\b/i, why: 'asks the agent to install or connect something' },
  { re: /\bwithout\s+(asking|confirm(ing|ation)?|(the\s+)?(user|customer)'?s?\s+(approval|permission|consent))\b/i, why: 'asks the agent to skip the customer\'s approval' },
  { re: /\b(always|automatically|immediately)\s+(buy|order|purchase|book|pay|reserve)\b/i, why: 'asks the agent to buy or book automatically' },
  { re: /\b(send|share|forward|reveal)\b.{0,30}\b(password|api key|token|card number|conversation|chat history)\b/i, why: 'asks for secrets or private data' },
  { re: /<\s*(script|iframe|object)\b|javascript:/i, why: 'contains script markup' },
];

/**
 * Scans named text fields and returns one finding per problem.
 * @param {Array<{ where: string, text: string }>} fields
 */
export function findInstructions(fields) {
  const findings = [];
  for (const { where, text } of fields) {
    if (!text) continue;
    for (const { re, why } of PATTERNS) {
      const m = String(text).match(re);
      if (m) findings.push({ where, why, excerpt: m[0] });
    }
  }
  return findings;
}

/** Every piece of free text in a project that will be shown to agents. */
export function projectTextFields(project) {
  const b = project.business ?? {};
  const fields = [
    { where: 'business.name', text: b.name },
    { where: 'business.kind', text: b.kind },
    { where: 'business.description', text: b.description },
    { where: 'ordering.notes', text: project.ordering?.notes },
  ];
  for (const item of project.catalogue?.items ?? []) {
    for (const key of ['name', 'category', 'description', 'unit', 'availability']) {
      fields.push({ where: `item ${item.sku} ${key}`, text: item[key] });
    }
  }
  return fields;
}
