/** Compile explicit data parameters into a reviewable definition; never executes code. */
import { randomUUID } from 'node:crypto';
import { validate } from './core.js';

export function instantiateTemplate(template, values = {}) {
  const fail = message => { throw new Error(message); };
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(template) || template.version !== 1 || !object(template.parameters) || !object(template.definition)) fail('invalid template');
  if (Object.keys(template).some(k => !['version', 'parameters', 'definition'].includes(k))) fail('unknown template field');
  if (!object(values)) fail('parameter values must be an object');
  const specs = template.parameters, parameters = Object.create(null);
  if (Object.keys(specs).length > 30) fail('too many parameters');
  for (const name of Object.keys(values)) if (!Object.hasOwn(specs, name)) fail(`unknown parameter: ${name}`);
  for (const [name, spec] of Object.entries(specs)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name) || name === 'runKey' || !object(spec)) fail('invalid parameter name/spec');
    if (Object.keys(spec).some(k => !['type', 'default', 'enum', 'min', 'max'].includes(k))) fail('unknown parameter spec field');
    const value = Object.hasOwn(values, name) ? values[name] : spec.default;
    if (spec.type === 'string') {
      if (typeof value !== 'string' || !value.trim() || value.length > 1000) fail(`invalid string parameter: ${name}`);
    } else if (spec.type === 'integer') {
      if (!Number.isSafeInteger(value) || (spec.min !== undefined && (!Number.isSafeInteger(spec.min) || value < spec.min)) || (spec.max !== undefined && (!Number.isSafeInteger(spec.max) || value > spec.max))) fail(`invalid integer parameter: ${name}`);
    } else fail(`unsupported parameter type: ${name}`);
    if (spec.enum !== undefined && (!Array.isArray(spec.enum) || !spec.enum.length || !spec.enum.includes(value))) fail(`parameter outside enum: ${name}`);
    parameters[name] = value;
  }
  const runKey = randomUUID();
  const replace = value => {
    if (typeof value === 'string') return value.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (_, key) => {
      if (key === 'runKey') return runKey;
      if (!Object.hasOwn(parameters, key)) fail(`undefined template parameter: ${key}`);
      return String(parameters[key]);
    });
    if (Array.isArray(value)) return value.map(replace);
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]));
    return value;
  };
  const rawProofs = [...(template.definition.deliveries ?? []), ...(template.definition.nodes ?? []).flatMap(n => n.proofs ?? [])];
  if (!rawProofs.length || rawProofs.some(p => typeof p?.path !== 'string' || !/^(output|artifacts)\/\{\{runKey\}\}\//.test(p.path))) fail('every artifact must be under output/{{runKey}}/ or artifacts/{{runKey}}/');
  if (Object.values(template.definition.references ?? {}).some(p => typeof p !== 'string' || p.includes('{{'))) fail('project references cannot be parameterized');
  const definition = replace(template.definition);
  if (typeof definition.intent !== 'string' || !definition.intent.trim()) fail('template intent is required');
  definition.intent += `\n本次参数 / Parameters: ${JSON.stringify(parameters)}\n输出批次 / Run key: ${runKey}`;
  return { definition: validate(definition), parameters: { ...parameters }, runKey };
}
